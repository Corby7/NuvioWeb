import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getFfmpegPaths, hasFfmpegSupport } from "./ffmpegBinaries.js";

// Anything here decodes natively; everything else needs re-encoding. Chromium refuses every
// Dolby and DTS codec on desktop (measured: ac-3, ec-3, ac-4, dtsc/dtsh/dtsx and mlpa all
// report "" from canPlayType and false from MediaSource.isTypeSupported). Video is fine, so
// only the audio track ever costs CPU.
const SUPPORTED_AUDIO_CODECS = new Set(["aac", "mp3", "flac", "opus", "vorbis", "pcm_s16le"]);

// Codecs that survive a straight copy into MP4 and still decode in Chromium. Narrower than
// SUPPORTED_AUDIO_CODECS on purpose: opus and vorbis are only reliable in WebM, and flac-in-MP4
// support is patchy, so those get re-encoded rather than remuxed.
const MP4_COPYABLE_AUDIO_CODECS = new Set(["aac", "mp3"]);

const PROBE_TIMEOUT_MS = 20000;
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
// A window is a bounded range request, but every invocation still reads the container header
// and index before it can seek; measured at 11-25s per window over a debrid link, and longer
// for a sparse track with no cues in range. Matches WINDOW_REQUEST_TIMEOUT_MS in
// localMediaBitmapSubtitleRepository, which bounds the equivalent webOS call.
const SUBTITLE_WINDOW_TIMEOUT_MS = 60000;

let server = null;
let serverPort = 0;
const accessToken = randomBytes(24).toString("hex");
const activeTranscodes = new Set();

// Playback decisions, the track menus and subtitle extraction all describe the same file. One
// ffprobe per URL serves all three; without this, opening the track dialog on a remote remux
// would re-probe (and re-range-request) a file already described moments earlier.
const probeCache = new Map();
const inFlightProbes = new Map();

function runFfprobe(sourceUrl) {
  const { ffprobe } = getFfmpegPaths();
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      // Remote remuxes can carry long headers; give the prober enough to find the
      // audio stream without pulling an unreasonable amount of the file.
      "-analyzeduration",
      "10M",
      "-probesize",
      "10M",
      sourceUrl
    ]);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffprobe timed out"));
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited with ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeCodecName(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanTag(value) {
  return String(value || "").trim();
}

// The renderer feeds these straight into playerScreen's normalizeEmbeddedAudioTracks /
// normalizeEmbeddedSubtitleTracks, which were written against the webOS Luna payload — so the
// key names here have to match that shape rather than ffprobe's.
function describeAudioStream(stream, index) {
  const tags = stream?.tags || {};
  const codec = normalizeCodecName(stream?.codec_name);
  const channels = Number(stream?.channels || 0) || 0;
  return {
    type: "audio",
    // Per-type index: what ffmpeg's -map 0:a:<i> expects, and what the menus select by.
    id: index,
    lang: cleanTag(tags.language),
    codec,
    audioCodec: codec,
    title: cleanTag(tags.title),
    label: cleanTag(tags.title),
    channels,
    channelCount: channels,
    channelLayout: cleanTag(stream?.channel_layout),
    sampleRate: Number(stream?.sample_rate || 0) || 0,
    default: Boolean(stream?.disposition?.default),
    playable: SUPPORTED_AUDIO_CODECS.has(codec)
  };
}

function describeSubtitleStream(stream, index) {
  const tags = stream?.tags || {};
  return {
    // "text" is what normalizeEmbeddedSubtitleTracks filters on; the codec below is what its
    // isUnsupportedEmbeddedSubtitleTrack check uses to drop bitmap formats such as PGS.
    type: "text",
    // 1-based, matching the Matroska track numbers webOS reports: the renderer treats a
    // sourceTrackId of 0 as "no track". Extraction subtracts one to get ffmpeg's -map index.
    id: index + 1,
    lang: cleanTag(tags.language),
    codec: normalizeCodecName(stream?.codec_name),
    title: cleanTag(tags.title),
    label: cleanTag(tags.title),
    forced: Boolean(stream?.disposition?.forced),
    default: Boolean(stream?.disposition?.default)
  };
}

// Pure description of the container. It deliberately makes no playback decision: which track to
// use depends on the user's language preference, which lives in the renderer.
async function describeMedia(sourceUrl) {
  const probe = await runFfprobe(sourceUrl);
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audioStreams = streams.filter((stream) => stream?.codec_type === "audio");
  const subtitleStreams = streams.filter((stream) => stream?.codec_type === "subtitle");
  const videoStream = streams.find((stream) => stream?.codec_type === "video") || null;
  const duration = Number(probe?.format?.duration || 0);

  return {
    available: true,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    container: String(probe?.format?.format_name || ""),
    videoCodec: normalizeCodecName(videoStream?.codec_name),
    // Chromium's demuxer binds the container's *first* audio stream — it does not go looking
    // for one it can decode. So this single flag, not "does a playable track exist anywhere",
    // decides whether direct playback can work at all.
    firstAudioPlayable: audioStreams.length > 0
      && SUPPORTED_AUDIO_CODECS.has(normalizeCodecName(audioStreams[0]?.codec_name)),
    audioTracks: audioStreams.map(describeAudioStream),
    subtitleTracks: subtitleStreams.map(describeSubtitleStream)
  };
}

export async function probeMedia(sourceUrl) {
  if (!hasFfmpegSupport()) {
    return { available: false };
  }

  const url = String(sourceUrl || "");
  const cached = probeCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  probeCache.delete(url);

  const inFlight = inFlightProbes.get(url);
  if (inFlight) {
    return inFlight;
  }

  const request = describeMedia(url)
    .then((value) => {
      probeCache.set(url, { value, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      inFlightProbes.delete(url);
    });

  inFlightProbes.set(url, request);
  return request;
}

// AAC needs more bits per channel pair than a stereo default allows; these keep a 5.1 bed from
// sounding compressed without wasting bandwidth on a loopback connection.
function audioBitrateForChannels(channels) {
  if (channels >= 6) {
    return "640k";
  }
  if (channels > 2) {
    return "384k";
  }
  return "192k";
}

function buildFfmpegArgs({ sourceUrl, startSeconds, audioStreamIndex, audioCodec, audioChannels }) {
  const args = ["-hide_banner", "-loglevel", "error"];

  // -ss before -i is an input seek: ffmpeg range-requests the remote file and starts at
  // the nearest preceding keyframe instead of decoding from zero.
  if (startSeconds > 0) {
    args.push("-ss", String(startSeconds));
  }

  args.push(
    "-i",
    sourceUrl,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${Math.max(0, Number(audioStreamIndex) || 0)}`,
    // Video is already playable, so it is copied — only the audio can cost CPU.
    "-c:v",
    "copy"
  );

  // A non-first AAC/MP3 track still has to come through here — Chromium would otherwise bind
  // stream 0 — but it only needs remuxing, not re-encoding. Skipping the encode keeps the
  // original quality and costs almost nothing.
  if (MP4_COPYABLE_AUDIO_CODECS.has(String(audioCodec || "").toLowerCase())) {
    args.push("-c:a", "copy");
  } else {
    // Chromium decodes multichannel AAC, and macOS folds it down for whatever output device is
    // attached — better than deciding here that everyone is on stereo speakers. 6 is the cap
    // because AAC-LC beyond 5.1 is not reliably decoded.
    const channels = Math.min(Math.max(Number(audioChannels) || 2, 1), 6);
    args.push(
      "-c:a",
      "aac",
      "-b:a",
      audioBitrateForChannels(channels),
      "-ac",
      String(channels),
      // Pins audio to its own timestamps instead of letting the re-encoded stream free-run.
      // Without this the copied video keeps its original (possibly irregular) timing while
      // AAC gets clean regenerated timing, and the two drift apart over a long runtime.
      // Only valid on this branch: ffmpeg rejects a filter alongside -c:a copy.
      "-af",
      "aresample=async=1"
    );
  }

  args.push(
    // Sync pair, and the order matters. -copyts keeps the source's relative stream
    // offsets, so a remux that carries a container audio delay stays aligned instead of
    // having both tracks flattened onto zero independently. make_zero then shifts every
    // stream by one common delta so playback still starts at zero.
    //
    // Measured on a beep/flash test clip seeking to 30s: no flags -0.0ms,
    // -copyts with avoid_negative_ts disabled -58.7ms (audio early), this pair -0.0ms.
    // Do not drop make_zero — bare -copyts regresses lip sync.
    "-copyts",
    "-avoid_negative_ts",
    "make_zero",
    "-sn",
    "-dn",
    "-f",
    "mp4",
    // Fragmented output so playback can start before the file is fully read.
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1"
  );

  return args;
}

async function handleStreamRequest(request, response, url) {
  const sourceUrl = url.searchParams.get("src") || "";
  const startSeconds = Math.max(0, Number(url.searchParams.get("start") || 0) || 0);
  const audioStreamIndex = Number(url.searchParams.get("audio") || 0) || 0;

  if (!sourceUrl) {
    response.writeHead(400).end("missing src");
    return;
  }

  // Cached from the probe the renderer already ran, so this does not re-read the file. Whether
  // the audio can be copied instead of re-encoded depends on the selected track's codec.
  let selectedTrack = null;
  try {
    const probe = await probeMedia(sourceUrl);
    selectedTrack = probe?.audioTracks?.[audioStreamIndex] || null;
  } catch (error) {
    // Falling through with no descriptor just means the audio gets re-encoded.
    console.warn("[mediaProxy] probe for stream request failed:", error.message);
  }
  if (response.writableEnded || request.destroyed) {
    return;
  }

  const { ffmpeg } = getFfmpegPaths();
  const child = spawn(
    ffmpeg,
    buildFfmpegArgs({
      sourceUrl,
      startSeconds,
      audioStreamIndex,
      audioCodec: selectedTrack?.codec || "",
      audioChannels: selectedTrack?.channels || 0
    })
  );
  activeTranscodes.add(child);

  // The length is unknown up front. Node applies chunked encoding by itself when no
  // content-length is set — declaring it here instead produces a malformed response.
  response.writeHead(200, {
    "content-type": "video/mp4",
    "cache-control": "no-store",
    "accept-ranges": "none"
  });

  child.stdout.pipe(response);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk).slice(0, 2000);
  });

  const cleanup = () => {
    activeTranscodes.delete(child);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  };

  child.on("error", (error) => {
    console.error("[mediaProxy] ffmpeg failed to start:", error.message);
    cleanup();
    response.destroy();
  });

  child.on("close", (code) => {
    activeTranscodes.delete(child);
    if (code !== 0 && code !== null && stderr) {
      console.error(`[mediaProxy] ffmpeg exited ${code}: ${stderr.slice(0, 500)}`);
    }
    response.end();
  });

  // A seek re-requests the stream, so the superseded transcode must die with its
  // response or every scrub would leak an ffmpeg process.
  request.on("close", cleanup);
  response.on("close", cleanup);
}

// Matroska interleaves subtitle packets across the whole file, so extracting a track end to end
// would download all of it. Instead this pulls the window around the playhead: -ss before -i is
// an input seek, so ffmpeg uses the container index and range-requests only that region. The
// webOS build does the same thing through its native service, which is why the renderer can
// drive both from one code path.
//
// Output timestamps are rebased to the seek point (verified: two overlapping windows extracted
// independently agree to 0.000s once the requested start is added back), so the caller offsets
// by startSeconds rather than trying to keep absolute timestamps through ffmpeg.
export function extractSubtitleWindow({ sourceUrl, trackIndex = 0, startSeconds = 0, durationSeconds = 0 }) {
  if (!hasFfmpegSupport()) {
    return Promise.reject(new Error("ffmpeg unavailable"));
  }
  const url = String(sourceUrl || "").trim();
  if (!url) {
    return Promise.reject(new Error("missing source url"));
  }

  const start = Math.max(0, Number(startSeconds) || 0);
  const duration = Math.max(1, Number(durationSeconds) || 0);
  const { ffmpeg } = getFfmpegPaths();
  const args = ["-hide_banner", "-loglevel", "error"];
  if (start > 0) {
    args.push("-ss", String(start));
  }
  args.push(
    "-i",
    url,
    "-t",
    String(duration),
    "-map",
    `0:s:${Math.max(0, Number(trackIndex) || 0)}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    "pipe:1"
  );

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args);
    activeTranscodes.add(child);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("subtitle extraction timed out"));
    }, SUBTITLE_WINDOW_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      activeTranscodes.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeTranscodes.delete(child);
      if (code !== 0 && code !== null) {
        reject(new Error(`subtitle ffmpeg exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolve({ vtt: stdout, startSeconds: start, durationSeconds: duration });
    });
  });
}

export function startMediaProxy() {
  if (server || !hasFfmpegSupport()) {
    return Promise.resolve(Boolean(server));
  }

  server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }

    // The port is loopback-only, but any local process could still reach it; the token
    // keeps it from being usable as a general-purpose transcoding proxy.
    if (url.searchParams.get("token") !== accessToken) {
      response.writeHead(403).end("forbidden");
      return;
    }

    if (url.pathname === "/stream") {
      handleStreamRequest(request, response, url).catch((error) => {
        console.error("[mediaProxy] stream request failed:", error.message);
        response.destroy();
      });
      return;
    }

    response.writeHead(404).end("not found");
  });

  // listen() binds asynchronously, so the port is only readable once "listening" fires.
  return new Promise((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      serverPort = typeof address === "object" && address ? address.port : 0;
      resolve(Boolean(serverPort));
    });
    server.once("error", (error) => {
      console.error("[mediaProxy] failed to start:", error.message);
      server = null;
      serverPort = 0;
      resolve(false);
    });
    server.listen(0, "127.0.0.1");
  });
}

// An input seek lands on the keyframe at or before the request, so the stream's real
// start is earlier than what was asked for — by up to a full GOP. Resolving that
// keyframe up front means ffmpeg is told exactly where to start and the caller knows the
// stream's true position, instead of assuming it equals the requested time.
const KEYFRAME_LOOKBACK_SECONDS = 20;

export async function resolveStreamStart(sourceUrl, requestedSeconds) {
  const seconds = Math.max(0, Number(requestedSeconds) || 0);
  if (!seconds || !hasFfmpegSupport()) {
    return 0;
  }

  const { ffprobe } = getFfmpegPaths();
  const from = Math.max(0, seconds - KEYFRAME_LOOKBACK_SECONDS);

  return new Promise((resolve) => {
    const child = spawn(ffprobe, [
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      // Only keyframes are decoded, and only across a bounded window, so this stays a
      // small range request rather than a scan of the whole file.
      "-skip_frame",
      "nokey",
      // ffprobe renamed this field: 4.x calls it pkt_pts_time, 5+ calls it pts_time.
      // Asking for both and matching on the key name keeps this working whichever
      // binary gets resolved (the bundled ffprobe is older than the bundled ffmpeg).
      "-show_entries",
      "frame=pts_time,pkt_pts_time",
      "-read_intervals",
      `${from}%${seconds + 0.5}`,
      "-of",
      "default=noprint_wrappers=1",
      sourceUrl
    ]);

    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(seconds);
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(seconds);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Matching on the key name matters: a bare Number("") is 0, which would otherwise
      // pass the range check and drag the result back to the start of the file.
      const candidates = stdout
        .split("\n")
        .map((line) => {
          const match = /(?:pkt_)?pts_time=([0-9]*\.?[0-9]+)/.exec(line);
          return match ? Number(match[1]) : Number.NaN;
        })
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= seconds);
      // Falling back to the requested time is safe: it only costs a slightly early start.
      resolve(candidates.length ? Math.max(...candidates) : seconds);
    });
  });
}

export function buildStreamUrl({ sourceUrl, startSeconds = 0, audioStreamIndex = 0 }) {
  if (!serverPort) {
    return "";
  }
  const params = new URLSearchParams({
    src: String(sourceUrl || ""),
    start: String(Math.max(0, Number(startSeconds) || 0)),
    audio: String(Math.max(0, Number(audioStreamIndex) || 0)),
    token: accessToken
  });
  return `http://127.0.0.1:${serverPort}/stream?${params.toString()}`;
}

export function stopMediaProxy() {
  for (const child of activeTranscodes) {
    child.kill("SIGKILL");
  }
  activeTranscodes.clear();
  probeCache.clear();
  inFlightProbes.clear();
  server?.close();
  server = null;
  serverPort = 0;
}
