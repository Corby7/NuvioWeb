import { accessSync, constants } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { app } from "electron";

const require = createRequire(import.meta.url);

function isExecutable(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Packaged builds get the binaries from extraResources; dev runs resolve them out of
// node_modules. The npm packages are not importable from inside an asar, which is why
// packaging copies them out rather than relying on require() at runtime.
function resolveBinary(name, resolveFromModules) {
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, "bin", name);
    if (isExecutable(packagedPath)) {
      return packagedPath;
    }
  }

  try {
    const modulePath = resolveFromModules();
    if (isExecutable(modulePath)) {
      return modulePath;
    }
  } catch {
    // Fall through to the PATH lookup below.
  }

  // Last resort: a system install (typically Homebrew during development).
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return "";
}

let cachedPaths = null;

export function getFfmpegPaths() {
  if (cachedPaths) {
    return cachedPaths;
  }

  cachedPaths = {
    ffmpeg: resolveBinary("ffmpeg", () => require("ffmpeg-static")),
    ffprobe: resolveBinary("ffprobe", () => require("ffprobe-static").path)
  };
  return cachedPaths;
}

export function hasFfmpegSupport() {
  const { ffmpeg, ffprobe } = getFfmpegPaths();
  return Boolean(ffmpeg && ffprobe);
}
