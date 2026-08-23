const { contextBridge, ipcRenderer } = require("electron");

// The renderer never gets ffmpeg or the proxy token — it asks the main process to make
// the decision and hands back a URL it can put straight on a <video>.
contextBridge.exposeInMainWorld("nuvioDesktop", {
  platform: "macos",

  // Lets the renderer distinguish "no ffmpeg on this machine" from "nothing to transcode".
  getCapabilities() {
    return ipcRenderer.invoke("nuvio:media-capabilities");
  },

  // Describes the container: duration, codecs, and every audio/subtitle track. Which track to
  // play is the renderer's call — it is the side that knows the user's language preference.
  probeMedia(sourceUrl) {
    return ipcRenderer.invoke("nuvio:probe-media", String(sourceUrl || ""));
  },

  buildStreamUrl(sourceUrl, options) {
    return ipcRenderer.invoke("nuvio:build-stream-url", {
      sourceUrl: String(sourceUrl || ""),
      startSeconds: Number(options?.startSeconds || 0),
      audioStreamIndex: Number(options?.audioStreamIndex || 0)
    });
  },

  // Returns WebVTT for a bounded window around the playhead, not the whole track — pulling a
  // full subtitle track out of a remote remux would mean downloading the entire file.
  extractSubtitleWindow(sourceUrl, options) {
    return ipcRenderer.invoke("nuvio:extract-subtitle-window", {
      sourceUrl: String(sourceUrl || ""),
      trackIndex: Number(options?.trackIndex || 0),
      startSeconds: Number(options?.startSeconds || 0),
      durationSeconds: Number(options?.durationSeconds || 0)
    });
  }
});
