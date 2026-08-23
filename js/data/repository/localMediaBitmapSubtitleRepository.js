import { requestWebOsCompanionService } from "../../platform/webos/webosCompanionService.js";
import { Platform } from "../../platform/index.js";
import { DesktopMediaBridge } from "../../platform/desktop/desktopMediaBridge.js";

const REQUEST_TIMEOUT_MS = 30000;
const WINDOW_REQUEST_TIMEOUT_MS = 60000;
const preparedSources = new Map();
const MAX_PREPARED_SOURCES = 4;

function withTimeout(promise, timeoutMs) {
  let timeoutId = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("webOS bitmap subtitle request timed out")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function decodeBase64(value) {
  const binary = globalThis.atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const VTT_TIMESTAMP_PATTERN = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function parseVttTimestamp(value) {
  const match = String(value || "").trim().match(VTT_TIMESTAMP_PATTERN);
  if (!match) {
    return null;
  }
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(String(match[4] || "0").padEnd(3, "0"));
  return (hours * 3600) + (minutes * 60) + seconds + (millis / 1000);
}

// Deliberately returns cue text untouched, exactly as the webOS service does: the caller runs
// it through sanitizeCueText, and sanitizing twice would strip the <br> the first pass produced
// and run the lines of a multi-line cue together.
function parseVttWindow(vtt, offsetSeconds) {
  const cues = [];
  String(vtt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .forEach((block) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        return;
      }
      const [startRaw, endRaw] = lines[timingIndex].split("-->");
      const start = parseVttTimestamp(startRaw);
      const end = parseVttTimestamp(endRaw);
      if (start == null || end == null || end <= start) {
        return;
      }
      const text = lines.slice(timingIndex + 1).join("\n").trim();
      if (!text) {
        return;
      }
      cues.push({
        startMs: Math.round((offsetSeconds + start) * 1000),
        endMs: Math.round((offsetSeconds + end) * 1000),
        text
      });
    });
  return cues;
}

export const localMediaBitmapSubtitleRepository = {
  async prepare(url) {
    const targetUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      throw new Error("Invalid embedded bitmap subtitle source");
    }
    if (preparedSources.has(targetUrl)) {
      return preparedSources.get(targetUrl);
    }
    const request = withTimeout(
      requestWebOsCompanionService({
        method: "bitmapSubtitlePrepare",
        parameters: { url: targetUrl }
      }),
      REQUEST_TIMEOUT_MS
    ).then((result) => {
      const payload = result?.payload || {};
      if (payload.returnValue === false) {
        throw new Error(payload.errorText || payload.errorCode || "Bitmap subtitle preparation failed");
      }
      return payload;
    }).catch((error) => {
      preparedSources.delete(targetUrl);
      throw error;
    });
    preparedSources.set(targetUrl, request);
    while (preparedSources.size > MAX_PREPARED_SOURCES) {
      preparedSources.delete(preparedSources.keys().next().value);
    }
    return request;
  },

  async getWindow({ url, trackNumber, startSeconds, endSeconds }) {
    const targetUrl = String(url || "").trim();
    const targetTrack = Math.trunc(Number(trackNumber));
    if (!/^https?:\/\//i.test(targetUrl) || !Number.isFinite(targetTrack) || targetTrack <= 0) {
      throw new Error("Invalid embedded bitmap subtitle request");
    }

    const windowStart = Math.max(0, Number(startSeconds) || 0);
    const windowEnd = Math.max(windowStart + 1, Number(endSeconds) || 0);

    // Desktop has no companion service; ffmpeg in the shell extracts the same window. Only
    // text tracks are handled — bitmap formats are filtered out of the menu before this point.
    if (Platform.isDesktop() && DesktopMediaBridge.isAvailable()) {
      const extracted = await DesktopMediaBridge.extractSubtitleWindow(targetUrl, {
        // sourceTrackId is 1-based to match webOS; ffmpeg's -map is 0-based per type.
        trackIndex: targetTrack - 1,
        startSeconds: windowStart,
        durationSeconds: windowEnd - windowStart
      });
      if (!extracted) {
        throw new Error("Desktop subtitle extraction failed");
      }
      // ffmpeg rebases output timestamps to the seek point, so the window start goes back on.
      const cues = parseVttWindow(extracted.vtt, windowStart);
      return {
        format: "text",
        textFormat: "utf8",
        trackNumber: targetTrack,
        windowStartSeconds: windowStart,
        windowEndSeconds: windowEnd,
        cueCount: cues.length,
        cues
      };
    }

    const result = await withTimeout(
      requestWebOsCompanionService({
        method: "bitmapSubtitleWindow",
        parameters: {
          url: targetUrl,
          trackNumber: targetTrack,
          startSeconds: Math.max(0, Number(startSeconds) || 0),
          endSeconds: Math.max(1, Number(endSeconds) || 0)
        }
      }),
      WINDOW_REQUEST_TIMEOUT_MS
    );
    const payload = result?.payload || {};
    if (payload.returnValue === false) {
      throw new Error(payload.errorText || payload.errorCode || "Bitmap subtitle extraction failed");
    }
    const format = String(payload.format || "").toLowerCase();
    if (format !== "vobsub" && format !== "pgs" && format !== "text") {
      throw new Error("Unsupported embedded subtitle response");
    }

    const base = {
      format,
      trackNumber: targetTrack,
      windowStartSeconds: Math.max(0, Number(payload.windowStartSeconds) || 0),
      windowEndSeconds: Math.max(0, Number(payload.windowEndSeconds) || 0),
      cueCount: Math.max(0, Math.trunc(Number(payload.cueCount) || 0))
    };

    // Text tracks come back as structured cues; the app renders them through
    // its own overlay so the subtitle style settings apply.
    if (format === "text") {
      return {
        ...base,
        textFormat: String(payload.textFormat || "utf8"),
        cues: Array.isArray(payload.cues) ? payload.cues : []
      };
    }

    return {
      ...base,
      // Only VOBSUB has a side-channel IDX index; for PGS the .sup byte stream
      // in subData is self-describing.
      idxContent: String(payload.idxContent || ""),
      subData: decodeBase64(payload.subBase64)
    };
  }
};
