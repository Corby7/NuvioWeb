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

function normalizeLanguage(value) {
  return String(value || "").trim().toLowerCase();
}

// Preference wins, then whatever the container marked as default, then simply the first track.
// Deliberately *not* "the first track Chromium can decode" — that was the old rule, and on a
// remux with lossless English first and an AAC dub later it silently picked the dub.
function chooseAudioTrack(audioTracks, preferredLanguages) {
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) {
    return -1;
  }

  // The caller passes every spelling of the preference ("en", "eng", …), so this only has to
  // strip any region suffix — no prefix matching, which would confuse "ar" with "arm".
  const targets = new Set(
    (Array.isArray(preferredLanguages) ? preferredLanguages : []).map(normalizeLanguage).filter(Boolean)
  );
  if (targets.size) {
    const preferred = audioTracks.findIndex((track) => {
      const language = normalizeLanguage(track?.lang);
      return Boolean(language) && (targets.has(language) || targets.has(language.split("-")[0]));
    });
    if (preferred >= 0) {
      return preferred;
    }
  }

  const defaultIndex = audioTracks.findIndex((track) => track?.default);
  return defaultIndex >= 0 ? defaultIndex : 0;
}

export const DesktopMediaBridge = {
  isAvailable() {
    return Boolean(getBridge());
  },

  async getCapabilities() {
    const bridge = getBridge();
    if (!bridge?.getCapabilities) {
      return { ffmpeg: false };
    }
    try {
      return (await bridge.getCapabilities()) || { ffmpeg: false };
    } catch (_) {
      return { ffmpeg: false };
    }
  },

  async probe(sourceUrl) {
    const bridge = getBridge();
    const url = String(sourceUrl || "").trim();
    if (!bridge || !url) {
      return null;
    }
    try {
      const probe = await bridge.probeMedia(url);
      return probe?.available ? probe : null;
    } catch (_) {
      return null;
    }
  },

  // Embedded audio + subtitle descriptors in the shape playerScreen's normalizers expect.
  async getTracks(sourceUrl) {
    const probe = await this.probe(sourceUrl);
    if (!probe) {
      return [];
    }
    return [...(probe.audioTracks || []), ...(probe.subtitleTracks || [])];
  },

  // Returns a transcode context when the stream needs one, otherwise null so the caller
  // plays the original URL untouched.
  async resolvePlaybackSource(
    sourceUrl,
    { preferredLanguages = [], force = false, audioStreamIndex = null } = {}
  ) {
    const bridge = getBridge();
    const url = String(sourceUrl || "").trim();
    if (!bridge || !url) {
      return null;
    }

    const probe = await this.probe(url);
    if (!probe) {
      return null;
    }

    const audioTracks = Array.isArray(probe.audioTracks) ? probe.audioTracks : [];
    // Number(null) is 0, not NaN — testing the raw value is what keeps "no track requested"
    // from reading as "requested track 0" and silently bypassing the chooser.
    const hasRequestedIndex = audioStreamIndex !== null && audioStreamIndex !== undefined;
    const requestedIndex = Number(audioStreamIndex);
    const chosenIndex = hasRequestedIndex && Number.isFinite(requestedIndex) && requestedIndex >= 0
      ? Math.min(requestedIndex, Math.max(0, audioTracks.length - 1))
      : chooseAudioTrack(audioTracks, preferredLanguages);
    if (chosenIndex < 0) {
      return null;
    }

    // Chromium binds the container's first audio stream, so direct playback is only viable
    // when the track we want *is* that stream and it is a codec Chromium decodes. Wanting any
    // other track is by itself a reason to go through the proxy, even if its codec is fine.
    const needsTranscode = force || !(chosenIndex === 0 && probe.firstAudioPlayable);
    if (!needsTranscode) {
      return null;
    }

    return this.buildContext(url, {
      probe,
      audioStreamIndex: chosenIndex,
      startSeconds: 0
    });
  },

  // Shared by first play, the error fallback and audio-track switching: everything that has to
  // point the element at the proxy needs the same context object.
  async buildContext(sourceUrl, { probe, audioStreamIndex = 0, startSeconds = 0 } = {}) {
    const bridge = getBridge();
    const url = String(sourceUrl || "").trim();
    if (!bridge || !url) {
      return null;
    }

    let stream = null;
    try {
      stream = await bridge.buildStreamUrl(url, { startSeconds, audioStreamIndex });
    } catch (_) {
      return null;
    }
    if (!stream?.url) {
      return null;
    }

    const audioTracks = Array.isArray(probe?.audioTracks) ? probe.audioTracks : [];
    return {
      sourceUrl: url,
      streamUrl: stream.url,
      startSeconds: Number(stream.startSeconds || 0),
      duration: Number(probe?.duration || 0),
      audioCodec: String(audioTracks[audioStreamIndex]?.codec || ""),
      audioStreamIndex: Number(audioStreamIndex || 0),
      audioTracks
    };
  },

  // WebVTT for the requested window, with timestamps relative to startSeconds.
  async extractSubtitleWindow(sourceUrl, { trackIndex = 0, startSeconds = 0, durationSeconds = 0 } = {}) {
    const bridge = getBridge();
    const url = String(sourceUrl || "").trim();
    if (!bridge?.extractSubtitleWindow || !url) {
      return null;
    }
    try {
      const result = await bridge.extractSubtitleWindow(url, {
        trackIndex,
        startSeconds,
        durationSeconds
      });
      return result?.vtt ? result : null;
    } catch (_) {
      return null;
    }
  },

  getAttachedContext(video) {
    return (video && attachedElements.get(video)?.context) || null;
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

  // Switching an embedded audio track means re-running ffmpeg with a different -map, so it is
  // a restart at the current position rather than anything the element can do itself.
  async setAudioTrack(video, audioStreamIndex) {
    const entry = video && attachedElements.get(video);
    if (!entry) {
      return false;
    }
    const index = Math.max(0, Number(audioStreamIndex) || 0);
    if (index === Number(entry.context.audioStreamIndex || 0)) {
      return true;
    }
    const position = entry.offset + Number(entry.currentTimeDescriptor.get.call(video) || 0);
    entry.context.audioStreamIndex = index;
    entry.context.audioCodec = String(entry.context.audioTracks?.[index]?.codec || "");
    await this.restartAt(video, position);
    return true;
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

    // Whatever happens from here, the element must not be left in a seeking state — a
    // swallowed failure used to hang the scrub bar with no way back.
    const abandon = () => {
      if (attachedElements.get(video) === entry && entry.restartToken === token) {
        dispatch(video, "seeked");
      }
    };

    let stream = null;
    try {
      stream = await bridge.buildStreamUrl(entry.context.sourceUrl, {
        startSeconds: seconds,
        audioStreamIndex: entry.context.audioStreamIndex
      });
    } catch (_) {
      abandon();
      return;
    }
    // A newer seek (or a teardown) landed while the URL was being built.
    if (attachedElements.get(video) !== entry || entry.restartToken !== token) {
      return;
    }
    if (!stream?.url) {
      abandon();
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
