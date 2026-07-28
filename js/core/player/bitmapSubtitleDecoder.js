let decoderModulePromise = null;

function installUtf8CodecFallbacks() {
  if (typeof globalThis.TextEncoder !== "function") {
    globalThis.TextEncoder = class TextEncoderFallback {
      encode(value = "") {
        const encoded = unescape(encodeURIComponent(String(value)));
        const bytes = new Uint8Array(encoded.length);
        for (let index = 0; index < encoded.length; index += 1) {
          bytes[index] = encoded.charCodeAt(index);
        }
        return bytes;
      }

      encodeInto(value, destination) {
        const text = String(value);
        let read = 0;
        let written = 0;
        while (read < text.length) {
          const firstUnit = text.charCodeAt(read);
          const hasSurrogatePair = firstUnit >= 0xd800
            && firstUnit <= 0xdbff
            && read + 1 < text.length;
          const character = text.slice(read, read + (hasSurrogatePair ? 2 : 1));
          const bytes = this.encode(character);
          if (written + bytes.length > destination.length) {
            break;
          }
          destination.set(bytes, written);
          written += bytes.length;
          read += character.length;
        }
        return { read, written };
      }
    };
  }

  if (typeof globalThis.TextDecoder !== "function") {
    globalThis.TextDecoder = class TextDecoderFallback {
      decode(value) {
        const bytes = value ? new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength) : new Uint8Array(0);
        let binary = "";
        const chunkSize = 8192;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
        }
        try {
          return decodeURIComponent(escape(binary));
        } catch (_) {
          return binary;
        }
      }
    };
  }
}

export function supportsBitmapSubtitleDecoding() {
  if (
    typeof globalThis.WebAssembly !== "object"
    || typeof globalThis.Uint8Array !== "function"
    || typeof globalThis.Uint8ClampedArray !== "function"
    || typeof globalThis.Promise !== "function"
    || (typeof globalThis.fetch !== "function" && typeof globalThis.XMLHttpRequest !== "function")
    || typeof globalThis.document?.createElement !== "function"
  ) {
    return false;
  }
  try {
    return Boolean(globalThis.document.createElement("canvas").getContext("2d"));
  } catch (_) {
    return false;
  }
}

// This app is packaged to run from file:// on webOS, where fetch() rejects the
// scheme outright. XHR does work there and reports status 0 on success — the
// same reason js/i18n/index.js carries an XHR loader for strings.xml.
function loadWasmBytesViaXhr(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
        resolve(xhr.response);
        return;
      }
      reject(new Error(`Bitmap subtitle decoder failed to load (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`Bitmap subtitle decoder request failed for ${url}`));
    xhr.send();
  });
}

async function loadWasmBytes(url) {
  if (typeof globalThis.fetch === "function") {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.arrayBuffer();
      }
      // A non-OK response on file:// is expected; fall through to XHR.
    } catch (_) {
      // fetch rejects for unsupported schemes — fall through to XHR.
    }
  }
  return loadWasmBytesViaXhr(url);
}

async function loadDecoderModule() {
  if (!supportsBitmapSubtitleDecoding()) {
    throw new Error("Bitmap subtitles are not supported by this TV browser");
  }
  if (!decoderModulePromise) {
    decoderModulePromise = (async () => {
      installUtf8CodecFallbacks();
      const [module, wasmBytes] = await Promise.all([
        import("libbitsub/pkg"),
        loadWasmBytes("assets/libs/libbitsub_bg.wasm")
      ]);
      await module.default({ module_or_path: wasmBytes });
      module.init();
      return module;
    })().catch((error) => {
      decoderModulePromise = null;
      throw error;
    });
  }
  return decoderModulePromise;
}

export async function warmBitmapSubtitleDecoder() {
  await loadDecoderModule();
  return true;
}

// A PGS cue can carry several independent image regions (e.g. a line of
// dialogue plus a separate caption). The render loop draws one image, so the
// regions are flattened into a single buffer covering their union.
function flattenPgsCompositions(frame, screenWidth, screenHeight) {
  const compositionCount = Number(frame?.compositionCount || 0);
  if (!Number.isFinite(compositionCount) || compositionCount <= 0) {
    return null;
  }

  const regions = [];
  for (let index = 0; index < compositionCount; index += 1) {
    const composition = frame.getComposition(index);
    if (!composition) {
      continue;
    }
    try {
      const width = Number(composition.width || 0);
      const height = Number(composition.height || 0);
      if (width > 0 && height > 0) {
        regions.push({
          x: Number(composition.x || 0),
          y: Number(composition.y || 0),
          width,
          height,
          rgba: new Uint8ClampedArray(composition.getRgba())
        });
      }
    } finally {
      composition.free?.();
    }
  }
  if (!regions.length) {
    return null;
  }

  const minX = Math.min(...regions.map((region) => region.x));
  const minY = Math.min(...regions.map((region) => region.y));
  const maxX = Math.max(...regions.map((region) => region.x + region.width));
  const maxY = Math.max(...regions.map((region) => region.y + region.height));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  // Fast path: one region already covering the union needs no copy.
  if (regions.length === 1 && regions[0].width === width && regions[0].height === height) {
    return {
      x: minX, y: minY, width, height, screenWidth, screenHeight, rgba: regions[0].rgba
    };
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  regions.forEach((region) => {
    const offsetX = region.x - minX;
    const offsetY = region.y - minY;
    for (let row = 0; row < region.height; row += 1) {
      const sourceStart = row * region.width * 4;
      const targetStart = ((offsetY + row) * width + offsetX) * 4;
      rgba.set(region.rgba.subarray(sourceStart, sourceStart + region.width * 4), targetStart);
    }
  });
  return { x: minX, y: minY, width, height, screenWidth, screenHeight, rgba };
}

export class BitmapSubtitleDecoder {
  constructor() {
    this.parser = null;
    this.format = "";
  }

  // payload is { format, idxContent, subData }. VOBSUB needs the IDX text plus
  // the .sub stream; PGS needs only the reconstructed .sup byte stream.
  async load(payload = {}) {
    this.dispose();
    const format = String(payload.format || "vobsub").toLowerCase();
    const module = await loadDecoderModule();
    const parser = format === "pgs" ? new module.PgsParser() : new module.VobSubParser();
    try {
      if (format === "pgs") {
        parser.parse(payload.subData);
      } else {
        parser.loadFromData(String(payload.idxContent || ""), payload.subData);
      }
      this.parser = parser;
      this.format = format;
    } catch (error) {
      parser.free?.();
      throw error;
    }
    return parser.count;
  }

  // Cheap lookup that avoids the decode: callers poll every tick, but a cue
  // typically spans several seconds, so re-rasterising the same image each time
  // is pure waste. Returns null when no cue covers the timestamp.
  getActiveCueAtSeconds(timeSeconds) {
    const parser = this.parser;
    if (!parser) {
      return null;
    }
    const timestampMs = Math.max(0, Number(timeSeconds) || 0) * 1000;
    const index = parser.findIndexAtTimestamp(timestampMs);
    if (!Number.isFinite(index) || index < 0 || index >= parser.count) {
      return null;
    }
    const startMs = parser.getCueStartTime(index);
    const endMs = parser.getCueEndTime(index);
    if (timestampMs < startMs || timestampMs >= endMs) {
      return null;
    }
    return { index, startMs, endMs };
  }

  renderAtSeconds(timeSeconds) {
    const parser = this.parser;
    if (!parser) {
      return null;
    }
    const active = this.getActiveCueAtSeconds(timeSeconds);
    if (!active) {
      return null;
    }
    const { index, startMs, endMs } = active;
    const frame = parser.renderAtIndex(index);
    if (!frame) {
      return null;
    }
    try {
      const key = `${index}:${startMs}:${endMs}`;
      if (this.format === "pgs") {
        // PgsParser exposes geometry on the parser, not the frame, and returns
        // compositions rather than a single ready-made image.
        const flattened = flattenPgsCompositions(
          frame,
          Number(parser.screenWidth || frame.width || 0),
          Number(parser.screenHeight || frame.height || 0)
        );
        return flattened ? { key, startMs, endMs, ...flattened } : null;
      }
      return {
        key,
        startMs,
        endMs,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        screenWidth: frame.screenWidth,
        screenHeight: frame.screenHeight,
        rgba: new Uint8ClampedArray(frame.getRgba())
      };
    } finally {
      frame.free?.();
    }
  }

  dispose() {
    if (!this.parser) {
      return;
    }
    try {
      this.parser.dispose?.();
      this.parser.free?.();
    } catch (_) {
      // Best effort cleanup for WASM-owned memory.
    }
    this.parser = null;
  }
}
