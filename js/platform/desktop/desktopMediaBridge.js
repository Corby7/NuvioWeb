// Desktop (Electron) only. Chromium refuses every Dolby/DTS audio codec, so streams
// carrying them play as silent video. The desktop shell can re-encode just the audio
// track through a local ffmpeg proxy; this module decides when that is needed and keeps
// the player's clock honest once it is.
//
// The proxy muxes with -copyts + -avoid_negative_ts make_zero: relative A/V offsets from
// the source survive, but the stream still starts at zero. So a transcoded source needs
// its position translating, and the shell reports where ffmpeg actually began — the
// keyframe at or before the seek, which can be a whole GOP earlier than the request.
// Rather than teach every currentTime reader about that, the element's own currentTime
// and duration are shadowed while a transcoded source is attached.

const attachedElements = new WeakMap();

function getBridge() {
  return globalThis.nuvioDesktop || null;
}

function getPrototypeDescriptor(name) {
  const prototype = globalThis.HTMLMediaElement?.prototype;
  return prototype ? Object.getOwnPropertyDescriptor(prototype, name) : null;
}

// Buffered ranges are in the stream's own (zero-based) domain, so this is the window the
// element can seek within without paying for an ffmpeg restart.
function getBufferedRange(video, nativeCurrentTime) {
  try {
    const ranges = video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (nativeCurrentTime >= start - 0.5 && nativeCurrentTime <= end) {
        return { start, end };
      }
    }
  } catch (_) {
    // TimeRanges can throw while the element is resetting.
  }
  return null;
}

function dispatch(video, eventName) {
  try {
    video.dispatchEvent(new Event(eventName));
  } catch (_) {
    // Ignore synthetic event failures.
  }
}

export const DesktopMediaBridge = {
  isAvailable() {
    return Boolean(getBridge());
  },

  // Returns a transcode context when the stream needs one, otherwise null so the caller
  // plays the original URL untouched.
  async resolvePlaybackSource(sourceUrl) {
    const bridge = getBridge();
    const url = String(sourceUrl || "").trim();
    if (!bridge || !url) {
      return null;
    }

    let probe = null;
    try {
      probe = await bridge.probeMedia(url);
    } catch (_) {
      return null;
    }
    if (!probe?.available || !probe.needsTranscode) {
      return null;
    }

    let stream = null;
    try {
      stream = await bridge.buildStreamUrl(url, {
        startSeconds: 0,
        audioStreamIndex: probe.audioStreamIndex
      });
    } catch (_) {
      return null;
    }
    if (!stream?.url) {
      return null;
    }

    return {
      sourceUrl: url,
      streamUrl: stream.url,
      startSeconds: Number(stream.startSeconds || 0),
      duration: Number(probe.duration || 0),
      audioCodec: String(probe.audioCodec || ""),
      audioStreamIndex: Number(probe.audioStreamIndex || 0)
    };
  },

  isAttached(video) {
    return Boolean(video && attachedElements.has(video));
  },

  attach(video, context) {
    if (!video || !context) {
      return false;
    }
    this.detach(video);

    const currentTimeDescriptor = getPrototypeDescriptor("currentTime");
    const durationDescriptor = getPrototypeDescriptor("duration");
    if (!currentTimeDescriptor?.get || !durationDescriptor?.get) {
      return false;
    }

    const entry = {
      context,
      offset: Number(context.startSeconds || 0),
      restartToken: 0,
      currentTimeDescriptor,
      durationDescriptor
    };
    attachedElements.set(video, entry);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      enumerable: false,
      get() {
        return entry.offset + Number(currentTimeDescriptor.get.call(video) || 0);
      },
      set(value) {
        DesktopMediaBridge.seek(video, Number(value));
      }
    });

    Object.defineProperty(video, "duration", {
      configurable: true,
      enumerable: false,
      get() {
        // Fragmented MP4 with empty_moov only reports what has been buffered so far;
        // the probed duration is the real one.
        return entry.context.duration > 0
          ? entry.context.duration
          : Number(durationDescriptor.get.call(video) || 0);
      }
    });

    return true;
  },

  detach(video) {
    const entry = video && attachedElements.get(video);
    if (!entry) {
      return;
    }
    attachedElements.delete(video);
    entry.restartToken += 1;
    try {
      delete video.currentTime;
      delete video.duration;
    } catch (_) {
      // The own properties are configurable; deletion should not fail.
    }
  },

  seek(video, targetSeconds) {
    const entry = video && attachedElements.get(video);
    if (!entry) {
      return;
    }
    const seconds = Math.max(0, Number(targetSeconds) || 0);
    const localTarget = seconds - entry.offset;
    const nativeCurrentTime = Number(entry.currentTimeDescriptor.get.call(video) || 0);
    const range = getBufferedRange(video, nativeCurrentTime);

    // Seeking inside what ffmpeg has already delivered is a normal native seek; only
    // leaving that window costs a restart.
    if (range && localTarget >= range.start && localTarget <= range.end) {
      entry.currentTimeDescriptor.set.call(video, localTarget);
      return;
    }

    this.restartAt(video, seconds);
  },

  async restartAt(video, seconds) {
    const entry = video && attachedElements.get(video);
    const bridge = getBridge();
    if (!entry || !bridge) {
      return;
    }

    entry.restartToken += 1;
    const token = entry.restartToken;
    const wasPlaying = !video.paused;
    dispatch(video, "seeking");

    let stream = null;
    try {
      stream = await bridge.buildStreamUrl(entry.context.sourceUrl, {
        startSeconds: seconds,
        audioStreamIndex: entry.context.audioStreamIndex
      });
    } catch (_) {
      return;
    }
    // A newer seek (or a teardown) landed while the URL was being built.
    if (!stream?.url || attachedElements.get(video) !== entry || entry.restartToken !== token) {
      return;
    }

    // Anchor to where ffmpeg really starts, not to what was asked for.
    entry.offset = Number(stream.startSeconds || 0);
    video.src = stream.url;
    video.load();

    const onLoadedMetadata = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      if (attachedElements.get(video) !== entry || entry.restartToken !== token) {
        return;
      }

      // The stream opens at the keyframe, so nudge forward to the exact target. This
      // goes through the native setter — the shadowed one would re-enter seek() and
      // could bounce into another restart.
      const localTarget = seconds - entry.offset;
      if (localTarget > 0) {
        entry.currentTimeDescriptor.set.call(video, localTarget);
      }

      if (wasPlaying) {
        video.play().catch(() => {
          // Autoplay is permitted in the shell; a rejection here is not recoverable.
        });
      }
      dispatch(video, "seeked");
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
  }
};
