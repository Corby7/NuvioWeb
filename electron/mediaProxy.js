import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getFfmpegPaths, hasFfmpegSupport } from "./ffmpegBinaries.js";

// Chromium refuses every Dolby and DTS codec on desktop (measured: ac-3, ec-3, ac-4,
// dtsc/dtsh/dtsx and mlpa all report "" from canPlayType and false from
// MediaSource.isTypeSupported). Video is fine, so only the audio track is re-encoded.
const UNSUPPORTED_AUDIO_CODECS = new Set([
  "ac3",
  "eac3",
  "ac4",
  "dts",
  "dca",
  "truehd",
  "mlp"
]);

// Anything here decodes natively, so the stream is handed over untouched.
const SUPPORTED_AUDIO_CODECS = new Set(["aac", "mp3", "flac", "opus", "vorbis", "pcm_s16le"]);

const PROBE_TIMEOUT_MS = 20000;

let server = null;
let serverPort = 0;
const accessToken = randomBytes(24).toString("hex");
const activeTranscodes = new Set();

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

export async function probeMedia(sourceUrl) {
  if (!hasFfmpegSupport()) {
    return { available: false, needsTranscode: false };
  }

  const probe = await runFfprobe(sourceUrl);
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audioStreams = streams.filter((stream) => stream?.codec_type === "audio");
  const videoStream = streams.find((stream) => stream?.codec_type === "video") || null;
  const duration = Number(probe?.format?.duration || 0);

  // Prefer an audio track Chromium can already play; only fall back to transcoding
  // when every track is a codec it refuses.
  const playableStream = audioStreams.find((stream) =>
    SUPPORTED_AUDIO_CODECS.has(normalizeCodecName(stream?.codec_name))
  );
  const firstStream = audioStreams[0] || null;
  const selectedStream = playableStream || firstStream;
  const selectedCodec = normalizeCodecName(selectedStream?.codec_name);

  return {
    available: true,
    needsTranscode: Boolean(selectedStream) && UNSUPPORTED_AUDIO_CODECS.has(selectedCodec),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    audioCodec: selectedCodec,
    videoCodec: normalizeCodecName(videoStream?.codec_name),
    // ffmpeg's -map uses the per-type index, not the absolute stream index.
    audioStreamIndex: selectedStream ? audioStreams.indexOf(selectedStream) : 0,
    audioTrackCount: audioStreams.length
  };
}

function buildFfmpegArgs({ sourceUrl, startSeconds, audioStreamIndex }) {
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
    // Video is already playable, so it is copied — only the audio costs CPU.
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    // Desktop output is typically stereo speakers or headphones; letting ffmpeg do the
    // downmix is better than shipping 5.1 that the OS folds down unpredictably.
    "-ac",
    "2",
    // Pins audio to its own timestamps instead of letting the re-encoded stream free-run.
    // Without this the copied video keeps its original (possibly irregular) timing while
    // AAC gets clean regenerated timing, and the two drift apart over a long runtime.
    "-af",
    "aresample=async=1",
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

function handleStreamRequest(request, response, url) {
  const sourceUrl = url.searchParams.get("src") || "";
  const startSeconds = Math.max(0, Number(url.searchParams.get("start") || 0) || 0);
  const audioStreamIndex = Number(url.searchParams.get("audio") || 0) || 0;

  if (!sourceUrl) {
    response.writeHead(400).end("missing src");
    return;
  }

  const { ffmpeg } = getFfmpegPaths();
  const child = spawn(ffmpeg, buildFfmpegArgs({ sourceUrl, startSeconds, audioStreamIndex }));
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
      handleStreamRequest(request, response, url);
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
  server?.close();
  server = null;
  serverPort = 0;
}
