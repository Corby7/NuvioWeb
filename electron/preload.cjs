const { contextBridge, ipcRenderer } = require("electron");

// The renderer never gets ffmpeg or the proxy token — it asks the main process to make
// the decision and hands back a URL it can put straight on a <video>.
contextBridge.exposeInMainWorld("nuvioDesktop", {
  platform: "macos",

  probeMedia(sourceUrl) {
    return ipcRenderer.invoke("nuvio:probe-media", String(sourceUrl || ""));
  },

  buildStreamUrl(sourceUrl, options) {
    return ipcRenderer.invoke("nuvio:build-stream-url", {
      sourceUrl: String(sourceUrl || ""),
      startSeconds: Number(options?.startSeconds || 0),
      audioStreamIndex: Number(options?.audioStreamIndex || 0)
    });
  }
});
