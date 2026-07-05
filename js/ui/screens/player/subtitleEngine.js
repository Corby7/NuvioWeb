// Subtitle fetch/decode/parse pipeline for the HTML overlay renderer.
//
// Turns remote SRT/VTT payloads into plain cue objects ({start, end, text,
// align}) so rendering, styling, and delay can happen entirely in app-owned
// DOM instead of the native ::cue pipeline (which is unreliable on TV
// browsers). Cue text is sanitized HTML: everything is escaped except
// <i>/<b>/<u>, so it is safe to assign to innerHTML.

// Subtitle files from addons are frequently not UTF-8 (SubDL and
// OpenSubtitles serve plenty of Windows-125x content). Map the declared
// subtitle language to the legacy codepage used when a strict UTF-8 decode
// fails.
const LANGUAGE_CODEPAGE_MAP = {
  cs: "windows-1250", hu: "windows-1250", pl: "windows-1250", ro: "windows-1250",
  sk: "windows-1250", sl: "windows-1250", hr: "windows-1250", bs: "windows-1250",
  ru: "windows-1251", bg: "windows-1251", sr: "windows-1251", mk: "windows-1251",
  uk: "windows-1251", be: "windows-1251",
  el: "windows-1253",
  tr: "windows-1254", az: "windows-1254",
  he: "windows-1255",
  ar: "windows-1256", fa: "windows-1256", ur: "windows-1256",
  et: "windows-1257", lt: "windows-1257", lv: "windows-1257",
  vi: "windows-1258",
  th: "windows-874"
};

function decodeWith(buffer, encoding, options = {}) {
  try {
    return new TextDecoder(encoding, options).decode(buffer);
  } catch (_) {
    return null;
  }
}

export function decodeSubtitleBuffer(arrayBuffer, { languageHint = "" } = {}) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (!bytes.length) {
    return "";
  }

  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return decodeWith(bytes.subarray(3), "utf-8") || "";
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return decodeWith(bytes, "utf-16le") || "";
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return decodeWith(bytes, "utf-16be") || "";
  }

  const strictUtf8 = decodeWith(bytes, "utf-8", { fatal: true });
  if (strictUtf8 !== null) {
    return strictUtf8;
  }

  const language = String(languageHint || "").trim().toLowerCase().split(/[-_]/)[0];
  const codepage = LANGUAGE_CODEPAGE_MAP[language] || "windows-1252";
  return decodeWith(bytes, codepage)
    || decodeWith(bytes, "windows-1252")
    || decodeWith(bytes, "utf-8")
    || "";
}

function escapeCueHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Extracts an ASS \an alignment (1-9) from inline override blocks, if any.
export function extractAssAlignment(text) {
  const match = String(text || "").match(/\{[^}]*\\an?([1-9])\b[^}]*\}/i);
  return match ? Number(match[1]) : 0;
}

// Converts raw cue payload text into sanitized HTML. Keeps <i>/<b>/<u>
// (both HTML-style tags common in SRT and ASS {\i1} overrides), drops
// everything else, escapes the rest. Allowed tags are tunnelled through the
// escape step with private-use sentinel characters so literal "i"/"b"/"u"
// text is never mistaken for markup.
const TAG_OPEN_SENTINEL = "\uE000";
const TAG_CLOSE_SENTINEL = "\uE001";
const SENTINEL_STRIP_PATTERN = /[\uE000\uE001]/g;
const SENTINEL_TAG_PATTERN = /\uE000(\/?)([ibu])\uE001/g;

function tagMarker(tag, closing = false) {
  return `${TAG_OPEN_SENTINEL}${closing ? "/" : ""}${tag}${TAG_CLOSE_SENTINEL}`;
}

export function sanitizeCueText(rawText) {
  let text = String(rawText || "")
    .replace(SENTINEL_STRIP_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ");

  // Convert ASS inline override blocks to basic style tags before escaping.
  const openTags = [];
  const closeTag = (tag) => {
    const output = [];
    for (let index = openTags.length - 1; index >= 0; index -= 1) {
      const activeTag = openTags[index];
      output.push(tagMarker(activeTag, true));
      openTags.splice(index, 1);
      if (activeTag === tag) {
        break;
      }
    }
    return output.join("");
  };
  const openTag = (tag) => {
    if (openTags.includes(tag)) {
      return "";
    }
    openTags.push(tag);
    return tagMarker(tag);
  };
  text = text.replace(/\{[^}]*\}/g, (block) => {
    let output = "";
    const commandPattern = /\\([ibu])([01])\b|\\r\b/gi;
    let match;
    while ((match = commandPattern.exec(block)) !== null) {
      if (match[0].toLowerCase() === "\\r") {
        output += closeTag("u") + closeTag("i") + closeTag("b");
        continue;
      }
      const tag = String(match[1] || "").toLowerCase();
      const enabled = String(match[2] || "") === "1";
      output += enabled ? openTag(tag) : closeTag(tag);
    }
    return output;
  });
  text += closeTag("u") + closeTag("i") + closeTag("b");

  // Preserve simple HTML style tags by tunnelling them through the escape.
  text = text.replace(/<\s*(\/?)\s*([ibu])\s*>/gi, (_, slash, tag) => tagMarker(tag.toLowerCase(), Boolean(slash)));
  // Remaining tags (VTT voice/class spans, font, ruby, ...) carry no styling
  // we support; drop the tags, keep their inner text.
  text = text.replace(/<\s*\/?\s*[a-zA-Z][^>\n]*>/g, "");

  text = escapeCueHtml(text)
    .replace(SENTINEL_TAG_PATTERN, "<$1$2>")
    .replace(SENTINEL_STRIP_PATTERN, "")
    .replace(/\n/g, "<br>");

  return text.trim();
}

const TIMESTAMP_PATTERN = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function parseTimestamp(value) {
  const match = String(value || "").trim().match(TIMESTAMP_PATTERN);
  if (!match) {
    return null;
  }
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(String(match[4] || "0").padEnd(3, "0"));
  return (hours * 3600) + (minutes * 60) + seconds + (millis / 1000);
}

// Parses SRT or VTT text into sorted cue objects. Tolerates missing cue
// numbers, missing hours, VTT settings after the timing line, and blank
// cues (skipped).
export function parseSubtitleText(content) {
  const normalized = String(content || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.trim()) {
    return [];
  }

  const cues = [];
  const blocks = normalized.split(/\n{2,}/);
  blocks.forEach((block) => {
    const lines = block.split("\n").map((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      return;
    }
    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start == null || end == null || end <= start) {
      return;
    }
    const rawText = lines.slice(timingIndex + 1).join("\n");
    if (!rawText.trim()) {
      return;
    }
    const align = extractAssAlignment(rawText);
    const text = sanitizeCueText(rawText);
    if (!text) {
      return;
    }
    cues.push({ start, end, text, align });
  });

  cues.sort((left, right) => left.start - right.start || left.end - right.end);
  return cues;
}

// Binary search for active cues at a given playback time. Cues are sorted
// by start time; overlapping cues are rare and short, so scanning a small
// window around the insertion point is sufficient and stays O(log n).
const ACTIVE_CUE_SCAN_WINDOW = 20;

export function findActiveCues(cues, timeSec) {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(timeSec)) {
    return [];
  }
  let low = 0;
  let high = cues.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (cues[mid].start <= timeSec) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (cues[low].start > timeSec) {
    return [];
  }
  const active = [];
  const scanStart = Math.max(0, low - ACTIVE_CUE_SCAN_WINDOW);
  for (let index = scanStart; index <= low; index += 1) {
    const cue = cues[index];
    if (cue.start <= timeSec && timeSec < cue.end) {
      active.push(cue);
    }
  }
  return active;
}

// Fetches and decodes a subtitle file, returning parsed cues.
// Returns [] on any failure - callers fall back to native <track> handling.
export async function fetchSubtitleCues(url, { headers = {}, languageHint = "", timeoutMs = 15000 } = {}) {
  const target = String(url || "").trim();
  if (!target) {
    return [];
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = null;
  try {
    if (controller && Number(timeoutMs) > 0) {
      timeoutId = setTimeout(() => {
        try {
          controller.abort();
        } catch (_) {
          // Ignore abort failures.
        }
      }, Number(timeoutMs));
    }
    const response = await fetch(target, {
      mode: "cors",
      headers,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      return [];
    }
    const buffer = await response.arrayBuffer();
    const text = decodeSubtitleBuffer(buffer, { languageHint });
    return parseSubtitleText(text);
  } catch (_) {
    return [];
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// Reads active cues from a native TextTrack (track mode). Text is sanitized
// through the same pipeline as parsed cues so overlay rendering is uniform.
export function collectNativeActiveCueText(track, timeSec) {
  const cues = track?.cues;
  if (!cues || typeof cues.length !== "number") {
    return [];
  }
  const items = [];
  const count = Number(cues.length || 0);
  for (let index = 0; index < count; index += 1) {
    const cue = cues[index] || cues.item?.(index) || null;
    if (!cue || typeof cue.startTime !== "number") {
      continue;
    }
    if (cue.startTime <= timeSec && timeSec < cue.endTime) {
      const raw = typeof cue.text === "string" ? cue.text : "";
      if (raw) {
        items.push({
          start: cue.startTime,
          end: cue.endTime,
          text: sanitizeCueText(raw),
          align: extractAssAlignment(raw)
        });
      }
    }
  }
  return items;
}
