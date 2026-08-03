import { LocalStore } from "../../../core/storage/localStore.js";

const STORE_KEY = "syncOriginClientId";

let cachedClientId = "";

function generateClientId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 v4 layout so the value stays a well-formed uuid on engines
  // without crypto.randomUUID (older webOS/Tizen builds).
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

// Stable per-installation id the backend uses to tag whichever client wrote a
// sync blob. Device-scoped on purpose: it is not profile- or account-scoped and
// must survive profile switches and sign-outs.
export function getSyncOriginClientId() {
  if (cachedClientId) {
    return cachedClientId;
  }
  const stored = String(LocalStore.get(STORE_KEY, "") || "").trim();
  if (stored) {
    cachedClientId = stored;
    return cachedClientId;
  }
  cachedClientId = generateClientId();
  LocalStore.set(STORE_KEY, cachedClientId);
  return cachedClientId;
}
