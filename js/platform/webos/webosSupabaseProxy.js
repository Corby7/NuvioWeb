import { Environment } from "../environment.js";
import {
  isWebOsCompanionServiceAvailable,
  requestWebOsCompanionService
} from "./webosCompanionService.js";

const WEBOS_SUPABASE_PROXY_REQUEST_TIMEOUT_MS = 22000;
const NULL_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

function withTimeout(promise, timeoutMs) {
  let timeoutId = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("webOS Supabase proxy status timed out")),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutPromise]).then(
    (value) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      return value;
    },
    (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      throw error;
    }
  );
}

function isProxyableSupabaseUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      parsed.pathname.startsWith("/rest/v1/") &&
      (host === "api.nuvio.tv" || host.endsWith(".supabase.co"))
    );
  } catch (_) {
    return false;
  }
}

function serializeBody(body) {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  return null;
}

function buildResponseFromServicePayload(payload) {
  const status = Number(payload?.statusCode || 0);
  if (!status) {
    return null;
  }
  const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
  const body = NULL_BODY_RESPONSE_STATUSES.has(status)
    ? null
    : typeof payload?.body === "string"
      ? payload.body
      : "";
  if (typeof Response === "function") {
    return new Response(body, {
      status,
      headers
    });
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return body || "";
    },
    // Callers that reach for .json() (e.g. AuthManager) must not blow up on
    // engines without a global Response constructor.
    async json() {
      return body ? JSON.parse(body) : null;
    }
  };
}

// `timeoutMs` is the caller's remaining budget for the whole request. The proxy
// leg is capped at the smaller of that and its own ceiling so that a caller
// asking for e.g. 5s does not sit here for 22s, and so that a proxy timeout
// followed by the direct-fetch fallback cannot exceed the caller's budget
// twice over. A non-positive budget means "unbounded" and keeps the ceiling.
export async function fetchViaWebOsSupabaseProxy(url, fetchOptions = {}, timeoutMs = 0) {
  if (!isProxyableSupabaseUrl(url)) {
    return null;
  }
  const body = serializeBody(fetchOptions.body);
  if (fetchOptions.body != null && body == null) {
    return null;
  }
  if (!Environment.isWebOS() || !isWebOsCompanionServiceAvailable()) {
    return null;
  }

  const budget = Number(timeoutMs);
  const proxyBudget = budget > 0
    ? Math.min(budget, WEBOS_SUPABASE_PROXY_REQUEST_TIMEOUT_MS)
    : WEBOS_SUPABASE_PROXY_REQUEST_TIMEOUT_MS;

  const serviceResult = await withTimeout(
    requestWebOsCompanionService({
      method: "supabaseProxy",
      parameters: {
        url: String(url || ""),
        method: fetchOptions.method || "GET",
        headers: fetchOptions.headers || {},
        body
      }
    }),
    proxyBudget
  ).catch(() => null);
  const serviceResponse = buildResponseFromServicePayload(serviceResult?.payload);
  if (serviceResponse) {
    return serviceResponse;
  }
  return null;
}
