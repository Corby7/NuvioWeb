import { SessionStore } from "../storage/sessionStore.js";
import { AuthManager } from "../auth/authManager.js";
import { fetchViaWebOsSupabaseProxy } from "../../platform/webos/webosSupabaseProxy.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

// Callers with special needs pass options.timeoutMs (0 disables the bound).
const DEFAULT_TIMEOUT_MS = 20000;

function toHeaderObject(headers) {
  if (!headers) {
    return {};
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

function hasHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === target);
}

// The proxy returns null both when it declines a request and when its own
// attempt fails, so a direct fetch is still tried afterwards. Both legs must
// therefore share one budget — giving each a full timeoutMs let a single
// request run for the sum of the two before surfacing an error.
async function dispatchRequest(url, fetchInit, timeoutMs) {
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  const startedAt = Date.now();
  const proxied = await fetchViaWebOsSupabaseProxy(url, fetchInit, budget);
  if (proxied) {
    return proxied;
  }
  if (!budget) {
    return fetchWithTimeout(url, fetchInit, 0);
  }
  // Leave a small floor so a nearly-exhausted budget still gets a real attempt
  // rather than aborting instantly.
  const remaining = Math.max(budget - (Date.now() - startedAt), 1000);
  return fetchWithTimeout(url, fetchInit, remaining);
}

export async function httpRequest(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const includeSessionAuth = options.includeSessionAuth !== false;

  const headers = toHeaderObject(options.headers);

  if (includeSessionAuth && SessionStore.refreshToken && AuthManager.isAccessTokenExpired()) {
    await AuthManager.refreshSessionIfNeeded();
  }

  if (includeSessionAuth && SessionStore.accessToken && !hasHeader(headers, "Authorization")) {
    headers["Authorization"] = `Bearer ${SessionStore.accessToken}`;
  }

  const body = options.body;
  const hasBody = body != null && method !== "GET" && method !== "HEAD";
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  const isSearchParams = typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams;
  if (hasBody && !hasHeader(headers, "Content-Type") && !isFormData && !isBlob && !isSearchParams) {
    headers["Content-Type"] = "application/json";
  }

  const {
    includeSessionAuth: _ignoredIncludeSessionAuth,
    timeoutMs: _ignoredTimeoutMs,
    ...fetchOptions
  } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchInit = {
    ...fetchOptions,
    method,
    credentials: fetchOptions.credentials || "omit",
    headers
  };

  let response = await dispatchRequest(url, fetchInit, timeoutMs);

  if (response.status === 401 && includeSessionAuth && SessionStore.refreshToken) {
    const refreshed = await AuthManager.refreshSessionIfNeeded({ force: true });
    if (refreshed && SessionStore.accessToken) {
      const retryInit = {
        ...fetchInit,
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${SessionStore.accessToken}`
        }
      };
      response = await dispatchRequest(url, retryInit, timeoutMs);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text);
    error.status = response.status;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.code === "string") {
          error.code = parsed.code;
        }
        if (typeof parsed.message === "string") {
          error.detail = parsed.message;
        }
      }
    } catch (parseError) {
      // Keep raw response text in error.message when payload is not JSON.
    }
    throw error;
  }

  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) {
    return null;
  }
  return JSON.parse(normalized);
}
