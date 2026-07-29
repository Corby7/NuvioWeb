import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncVersionFiles } from "./appMetadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const buildResourcesDir = path.join(rootDir, "build");
const releaseDir = path.join(rootDir, "release");
const iconSourcePath = path.join(rootDir, "assets", "images", "tizenIcon.png");
const iconTargetPath = path.join(buildResourcesDir, "icon.png");

const buildDmg = process.argv.slice(2).includes("--dmg");

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertDistExists() {
  try {
    await access(path.join(distDir, "app.bundle.js"), fsConstants.R_OK);
    await access(path.join(distDir, "index.html"), fsConstants.R_OK);
  } catch {
    throw new Error(`Build output not found at ${distDir}. Run "npm run build" first.`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

// electron-builder converts build/icon.png into the .icns itself, but it requires at
// least 512x512 — the webOS icons are far smaller, so derive it from the Tizen artwork.
async function prepareIcon() {
  const [sourceStat, targetStat] = await Promise.all([
    stat(iconSourcePath).catch(() => null),
    stat(iconTargetPath).catch(() => null)
  ]);

  if (!sourceStat) {
    throw new Error(`Icon source not found at ${iconSourcePath}`);
  }
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) {
    return;
  }

  console.log("generating macOS app icon...");
  await mkdir(buildResourcesDir, { recursive: true });
  await run("sips", [
    "-s",
    "format",
    "png",
    "-z",
    "1024",
    "1024",
    iconSourcePath,
    "--out",
    iconTargetPath
  ]);
}

async function findAppBundle() {
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidates = await readdir(path.join(releaseDir, entry.name)).catch(() => []);
    const appName = candidates.find((name) => name.endsWith(".app"));
    if (appName) {
      return path.join(releaseDir, entry.name, appName);
    }
  }
  return "";
}

// Unsigned bundles are refused outright on Apple Silicon. An ad-hoc signature is enough
// for local installs; real distribution needs a Developer ID identity instead.
async function adHocSign(appPath) {
  console.log(`ad-hoc signing ${path.basename(appPath)}...`);
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

async function packageMacOs() {
  if (process.platform !== "darwin") {
    throw new Error("macOS packaging must run on macOS (sips and codesign are required).");
  }

  const version = await syncVersionFiles();
  await assertDistExists();
  await prepareIcon();

  console.log(`packaging Nuvio TV ${version} for macOS...`);
  await rm(releaseDir, { recursive: true, force: true });

  const electronBuilderBin = path.join(rootDir, "node_modules", ".bin", "electron-builder");
  if (!(await pathExists(electronBuilderBin))) {
    throw new Error('electron-builder not installed. Run "npm install" first.');
  }

  await run(electronBuilderBin, ["--mac", buildDmg ? "dmg" : "dir"], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
  });

  const appPath = await findAppBundle();
  if (!appPath) {
    throw new Error(`No .app bundle found under ${releaseDir}`);
  }
  await adHocSign(appPath);

  console.log(`\nmacOS app ready: ${appPath}`);
  if (buildDmg) {
    console.log("DMG written to ./release");
  }
}

try {
  await packageMacOs();
} catch (error) {
  console.error("\nmacOS packaging failed:");
  console.error(error);
  process.exit(1);
}
