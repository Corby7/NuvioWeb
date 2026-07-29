import { app, BrowserWindow, Menu, ipcMain, screen, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasFfmpegSupport } from "./ffmpegBinaries.js";
import {
  buildStreamUrl,
  probeMedia,
  resolveStreamStart,
  startMediaProxy,
  stopMediaProxy
} from "./mediaProxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const indexPath = path.join(distDir, "index.html");

const appName = "Nuvio TV";

// The UI is sized for a 1080p TV: the clamp() floors in base.css (42px titles, 104px
// sidebar items, fixed-px rails) are calibrated for that viewport, so a smaller window
// just hits the floors and looks magnified. Scaling the page against the TV reference
// keeps the layout identical to the webOS build instead of forking the CSS.
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;
const disableWebSecurity = /^(1|true|yes|on)$/i.test(
  String(process.env.NUVIO_DISABLE_WEB_SECURITY || "")
);
const openDevTools = /^(1|true|yes|on)$/i.test(String(process.env.NUVIO_DEVTOOLS || ""));

// The renderer loads from file://, so every addon/TMDB/Supabase call is cross-origin
// with an opaque ("null") origin. Chromium blocks those unless the response opts in,
// which arbitrary Stremio addons do not reliably do — so we grant it in the main
// process instead of turning webSecurity off wholesale.
const CORS_STRIPPED_HEADERS = new Set([
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers"
]);

// details.id is stable across the request lifecycle, so the origin captured on the way
// out can be echoed back on the way in (an exact echo is required for credentialed CORS,
// where "*" is rejected).
const pendingRequestOrigins = new Map();

function readHeader(headers, name) {
  const match = Object.keys(headers || {}).find((key) => key.toLowerCase() === name);
  if (!match) {
    return "";
  }
  const value = headers[match];
  return String(Array.isArray(value) ? value[0] : value || "");
}

function applyPermissiveCorsHeaders() {
  const { webRequest } = session.defaultSession;

  webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = readHeader(details.requestHeaders, "origin");
    const requestedHeaders = readHeader(details.requestHeaders, "access-control-request-headers");
    if (origin || requestedHeaders) {
      pendingRequestOrigins.set(details.id, { origin, requestedHeaders });
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  webRequest.onHeadersReceived((details, callback) => {
    const tracked = pendingRequestOrigins.get(details.id) || {};
    pendingRequestOrigins.delete(details.id);

    const responseHeaders = {};
    for (const [key, value] of Object.entries(details.responseHeaders || {})) {
      if (!CORS_STRIPPED_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }

    const origin = tracked.origin || "null";
    responseHeaders["access-control-allow-origin"] = [origin];
    responseHeaders["access-control-allow-credentials"] = ["true"];
    responseHeaders["access-control-allow-methods"] = ["GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"];
    responseHeaders["access-control-expose-headers"] = ["*"];
    // "*" is not honoured for credentialed requests, so echo what was actually asked for.
    responseHeaders["access-control-allow-headers"] = [
      tracked.requestedHeaders || "*,authorization,apikey,content-type,range,x-client-info"
    ];

    callback({ responseHeaders });
  });

  webRequest.onCompleted((details) => pendingRequestOrigins.delete(details.id));
  webRequest.onErrorOccurred((details) => pendingRequestOrigins.delete(details.id));
}

async function registerMediaHandlers() {
  if (!hasFfmpegSupport()) {
    console.warn("[nuvio] ffmpeg not found — Dolby/DTS streams will play without audio.");
    return;
  }
  // Must finish binding before the renderer can ask for a stream URL.
  await startMediaProxy();

  ipcMain.handle("nuvio:probe-media", async (_event, sourceUrl) => {
    try {
      return await probeMedia(String(sourceUrl || ""));
    } catch (error) {
      // A failed probe must never block playback — fall through to direct playback.
      console.warn("[nuvio] media probe failed:", error.message);
      return { available: false, needsTranscode: false };
    }
  });

  // Returns the stream's true start alongside the URL, so the renderer's clock can be
  // anchored to where ffmpeg actually began rather than where the seek asked to go.
  ipcMain.handle("nuvio:build-stream-url", async (_event, options) => {
    const request = options || {};
    const startSeconds = await resolveStreamStart(request.sourceUrl, request.startSeconds);
    return {
      url: buildStreamUrl({ ...request, startSeconds }),
      startSeconds
    };
  });
}

function buildApplicationMenu() {
  const template = [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Scaling on the smaller axis keeps the whole 1080p layout on screen whatever the window
// aspect is; the roomier axis just gains a little extra logical space.
function applyTvScale(window) {
  if (!window || window.isDestroyed()) {
    return;
  }
  const [width, height] = window.getContentSize();
  if (!width || !height) {
    return;
  }
  const scale = Math.min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT);
  const zoomFactor = Math.min(Math.max(scale, MIN_ZOOM_FACTOR), MAX_ZOOM_FACTOR);
  window.webContents.setZoomFactor(zoomFactor);
}

// Open at the largest 16:9 content area that leaves the display's chrome breathing room.
function computeDefaultContentSize() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const scale = Math.min(
    (workAreaSize.width * 0.9) / REFERENCE_WIDTH,
    (workAreaSize.height * 0.9) / REFERENCE_HEIGHT,
    1
  );
  return {
    width: Math.round(REFERENCE_WIDTH * scale),
    height: Math.round(REFERENCE_HEIGHT * scale)
  };
}

function createWindow() {
  const { width: defaultWidth, height: defaultHeight } = computeDefaultContentSize();

  const window = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: 960,
    minHeight: 540,
    // Sizes describe the web content, so the title bar never eats into the 16:9 area.
    useContentSize: true,
    backgroundColor: "#000000",
    title: appName,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The TV UI keeps timers running for rails, progress and the player; throttling a
      // backgrounded window stalls playback bookkeeping.
      backgroundThrottling: false,
      webSecurity: !disableWebSecurity,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  window.once("ready-to-show", () => {
    applyTvScale(window);
    window.show();
    if (openDevTools) {
      window.webContents.openDevTools({ mode: "detach" });
    }
  });

  // The zoom factor is reset by every load, so re-apply it rather than set it once.
  window.webContents.on("did-finish-load", () => applyTvScale(window));
  window.on("resize", () => applyTvScale(window));
  window.on("enter-full-screen", () => applyTvScale(window));
  window.on("leave-full-screen", () => applyTvScale(window));

  // Login QR codes, donation links and addon config pages belong in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Nothing should ever navigate the shell away from the bundled app.
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:/i.test(url)) {
        shell.openExternal(url);
      }
    }
  });

  window.loadFile(indexPath);
  return window;
}

// Hero videos and the player start without a click; Chromium's default policy would
// block them.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Lets macOS hand HEVC off to the platform decoder instead of software-decoding it.
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setName(appName);
    applyPermissiveCorsHeaders();
    // Awaited before the window exists so the renderer can never invoke a handler that
    // has not been registered yet.
    await registerMediaHandlers();
    buildApplicationMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // This is a single-window media app, not a document app — closing the window means done.
  app.on("window-all-closed", () => {
    app.quit();
  });

  // Orphaned ffmpeg children would outlive the app otherwise.
  app.on("before-quit", stopMediaProxy);
}
