import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppMetadata } from "./appMetadata.mjs";
import { runAresCli } from "./aresCli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// ares-install falls back to the CLI profile's default device (the emulator,
// port 6622) when no -d is given, which fails with ECONNREFUSED unless the
// emulator happens to be running. Default to the TV instead; override with
// -d/--device or NUVIO_WEBOS_DEVICE.
const DEFAULT_DEVICE = process.env.NUVIO_WEBOS_DEVICE || "lgc3";

function hasPackageArg(args) {
  return args.some((arg) => !arg.startsWith("-") && arg.endsWith(".ipk"));
}

// Returns the caller's device args (["-d", "name"] or ["--device=name"]) so
// the relaunch step can reuse them, or null when none were given.
function extractDeviceArgs(args) {
  const flagIndex = args.findIndex((arg) => arg === "-d" || arg === "--device");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return [args[flagIndex], args[flagIndex + 1]];
  }
  const inlineArg = args.find((arg) => arg.startsWith("--device="));
  return inlineArg ? [inlineArg] : null;
}

async function resolveDefaultPackagePath() {
  const { version } = await readAppMetadata();
  const packagePath = path.join(rootDir, `space.nuvio.webos_${version}_all.ipk`);
  try {
    await access(packagePath, fsConstants.R_OK);
  } catch {
    throw new Error(`Package not found at ${packagePath}. Run "npm run package:webos" first.`);
  }
  return packagePath;
}

async function readAppId() {
  try {
    const appInfo = JSON.parse(await readFile(path.join(rootDir, "appinfo.json"), "utf8"));
    return String(appInfo?.id || "").trim();
  } catch {
    return "";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const withPackage = hasPackageArg(args) ? args : [await resolveDefaultPackagePath(), ...args];
  const callerDevice = extractDeviceArgs(withPackage);
  const deviceArgs = callerDevice || ["-d", DEFAULT_DEVICE];
  const installArgs = callerDevice ? withPackage : [...deviceArgs, ...withPackage];

  await runAresCli("ares-install", installArgs);

  // Relaunch so the freshly installed build is actually running; a plain
  // install leaves the previous instance (or nothing) on screen.
  const appId = await readAppId();
  if (appId) {
    await runAresCli("ares-launch", [...deviceArgs, "--close", appId]).catch(() => {
      // Not running — nothing to close.
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await runAresCli("ares-launch", [...deviceArgs, appId]);
  }
}

try {
  await main();
} catch (error) {
  console.error("\nwebOS install failed:");
  console.error(error);
  process.exit(1);
}
