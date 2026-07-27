import { AuthState } from "./authState.js";
import { SessionStore } from "../storage/sessionStore.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../../config.js";
import { fetchWithTimeout } from "../network/fetchWithTimeout.js";
import { fetchViaWebOsSupabaseProxy } from "../../platform/webos/webosSupabaseProxy.js";

// AuthManager cannot route through httpClient (httpClient imports AuthManager),
// so it mirrors httpClient's dispatch here: try the webOS native proxy first —
// on TV the app runs from file:// and direct Supabase fetches may not complete —
// then fall back to a *bounded* fetch. These calls were previously bare fetch(),
// which meant an unbounded hang on the boot path (getEffectiveUserId is awaited
// by ProfileSyncService/LibrarySyncService) and no proxy on the target platform.
const AUTH_REQUEST_TIMEOUT_MS = 20000;

async function dispatchSupabaseRequest(url, init = {}, timeoutMs = AUTH_REQUEST_TIMEOUT_MS) {
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  const startedAt = Date.now();
  const proxied = await fetchViaWebOsSupabaseProxy(url, init, budget);
  if (proxied) {
    return proxied;
  }
  if (!budget) {
    return fetchWithTimeout(url, init, 0);
  }
  const remaining = Math.max(budget - (Date.now() - startedAt), 1000);
  return fetchWithTimeout(url, init, remaining);
}

function isJwtLike(token) {
  const value = String(token || "").trim();
  return value.split(".").length === 3;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isJwtExpired(token, leewaySeconds = 30) {
  if (!isJwtLike(token)) {
    return true;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    // Three segments but an undecodable payload means the stored token is
    // corrupt. Treating that as "not expired" (the old behaviour) short-
    // circuited refreshSessionIfNeeded into returning true, so bootstrap went
    // AUTHENTICATED with a token every API call would 401 on, and nothing ever
    // triggered a refresh to recover. Report it expired so it gets replaced.
    return true;
  }
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    // Decoded cleanly but carries no expiry — nothing to check against.
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + leewaySeconds;
}

// Subject (user id) the current access token was issued for, used to tie the
// cached effective user id to the account it was resolved under.
function currentTokenSubject() {
  const payload = decodeJwtPayload(SessionStore.accessToken);
  const sub = payload?.sub;
  return sub == null ? null : String(sub);
}

function isTransientNetworkError(error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();
  return (
    name === "typeerror" ||
    name === "aborterror" ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("load failed") ||
    message.includes("internet") ||
    message.includes("offline")
  );
}

class AuthManagerClass {
  constructor() {
    this.state = AuthState.LOADING;
    this.listeners = [];
    this.cachedEffectiveUserId = null;
    this.cachedEffectiveUserSourceUserId = null;
    this.refreshPromise = null;
    this.lastRefreshFailureKind = null;
  }

  // ------------------------------------
  // SUBSCRIBE (equivalente StateFlow)
  // ------------------------------------
  subscribe(listener) {
    this.listeners.push(listener);
    listener(this.state);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  setState(newState) {
    this.state = newState;
    this.listeners.forEach((l) => l(newState));
  }

  // ------------------------------------
  // BOOTSTRAP (equivalente observeSessionStatus)
  // ------------------------------------
  async bootstrap() {
    const token = SessionStore.accessToken;

    if (!token) {
      this.setState(AuthState.SIGNED_OUT);
      return;
    }

    if (SessionStore.isAnonymousSession) {
      this.setState(AuthState.SIGNED_OUT);
      return;
    }

    const refreshed = await this.refreshSessionIfNeeded();
    if (!refreshed) {
      this.setState(AuthState.SIGNED_OUT);
      return;
    }

    this.setState(AuthState.AUTHENTICATED);
  }

  getAuthState() {
    return this.state;
  }

  get isAuthenticated() {
    return this.state === AuthState.AUTHENTICATED;
  }

  wasLastSessionRefreshTransientFailure() {
    return this.lastRefreshFailureKind === "transient";
  }

  isAccessTokenExpired(leewaySeconds = 30) {
    return isJwtExpired(SessionStore.accessToken, leewaySeconds);
  }

  // ------------------------------------
  // EMAIL LOGIN
  // ------------------------------------
  async signInWithEmail(email, password) {
    const res = await dispatchSupabaseRequest(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) throw new Error("Login failed");

    const data = await res.json();

    SessionStore.accessToken = data.access_token;
    SessionStore.refreshToken = data.refresh_token;
    SessionStore.isAnonymousSession = false;

    this.cachedEffectiveUserId = null;
    this.cachedEffectiveUserSourceUserId = null;

    this.setState(AuthState.AUTHENTICATED);
  }

  async signOut() {
    SessionStore.clear();
    this.cachedEffectiveUserId = null;
    this.cachedEffectiveUserSourceUserId = null;
    this.setState(AuthState.SIGNED_OUT);
  }

  async refreshSessionIfNeeded({ force = false } = {}) {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.lastRefreshFailureKind = null;
    const accessToken = SessionStore.accessToken;
    const refreshToken = SessionStore.refreshToken;
    if (!refreshToken) {
      return Boolean(accessToken) && !isJwtExpired(accessToken, 0);
    }

    if (!force && accessToken && !isJwtExpired(accessToken)) {
      return true;
    }

    this.refreshPromise = (async () => {
      try {
        const res = await fetchWithTimeout(
          `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ refresh_token: refreshToken })
          },
          8000
        );
        if (!res.ok) {
          // Only 4xx means the session itself is invalid. A 5xx/522 is a
          // backend outage: keep the session so a flaky backend can't sign
          // the user out at boot; API calls will retry refresh via their
          // own 401 handling once the backend recovers.
          if (res.status >= 500 && accessToken) {
            this.lastRefreshFailureKind = "transient";
            console.warn(`Session refresh unavailable (HTTP ${res.status}); keeping existing session`);
            return true;
          }
          this.lastRefreshFailureKind = "rejected";
          return false;
        }
        const data = await res.json();
        if (!data?.access_token) {
          this.lastRefreshFailureKind = "invalid";
          return false;
        }
        SessionStore.accessToken = data.access_token;
        if (data.refresh_token) {
          SessionStore.refreshToken = data.refresh_token;
        }
        this.lastRefreshFailureKind = null;
        return true;
      } catch (error) {
        console.warn("Session refresh failed", error);
        if (isTransientNetworkError(error) && accessToken) {
          this.lastRefreshFailureKind = "transient";
          return true;
        }
        this.lastRefreshFailureKind = "failed";
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  // ------------------------------------
  // QR LOGIN FLOW
  // ------------------------------------

  async startTvLoginSession(deviceNonce, deviceName, redirectBaseUrl) {
    const res = await dispatchSupabaseRequest(`${SUPABASE_URL}/rest/v1/rpc/start_tv_login_session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SessionStore.accessToken}`
      },
      body: JSON.stringify({
        p_device_nonce: deviceNonce,
        p_redirect_base_url: redirectBaseUrl,
        ...(deviceName && { p_device_name: deviceName })
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    return data[0];
  }

  async pollTvLoginSession(code, deviceNonce) {
    const res = await dispatchSupabaseRequest(`${SUPABASE_URL}/rest/v1/rpc/poll_tv_login_session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SessionStore.accessToken}`
      },
      body: JSON.stringify({
        p_code: code,
        p_device_nonce: deviceNonce
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    return data[0];
  }

  async exchangeTvLoginSession(code, deviceNonce) {
    const res = await dispatchSupabaseRequest(`${SUPABASE_URL}/functions/v1/tv-logins-exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SessionStore.accessToken}`
      },
      body: JSON.stringify({
        code,
        device_nonce: deviceNonce
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();

    SessionStore.accessToken = data.accessToken;
    SessionStore.refreshToken = data.refreshToken;

    this.cachedEffectiveUserId = null;
    this.cachedEffectiveUserSourceUserId = null;

    this.setState(AuthState.AUTHENTICATED);
  }

  // ------------------------------------
  // EFFECTIVE USER ID (PORTING CACHE LOGIC)
  // ------------------------------------

  async getEffectiveUserId() {
    // Only trust the cache while the token still belongs to the account it was
    // resolved under. cachedEffectiveUserSourceUserId previously existed but was
    // never written, so signing in as a different user without an intervening
    // signOut() (which is the only thing that cleared the cache) kept serving
    // the previous account's owner id to every profile-scoped store.
    const tokenSubject = currentTokenSubject();
    if (this.cachedEffectiveUserId && this.cachedEffectiveUserSourceUserId === tokenSubject) {
      return this.cachedEffectiveUserId;
    }
    this.cachedEffectiveUserId = null;
    this.cachedEffectiveUserSourceUserId = null;

    if (!SessionStore.accessToken) {
      const refreshed = await this.refreshSessionIfNeeded();
      if (!refreshed || !SessionStore.accessToken) {
        await this.signOut();
        throw new Error("Missing valid session token");
      }
    }

    const authHeaders = {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SessionStore.accessToken}`
    };

    let res = await dispatchSupabaseRequest(`${SUPABASE_URL}/rest/v1/rpc/get_sync_owner`, {
      method: "POST",
      headers: authHeaders
    });

    if (res.status === 401) {
      const refreshed = await this.refreshSessionIfNeeded();
      if (refreshed) {
        res = await dispatchSupabaseRequest(`${SUPABASE_URL}/rest/v1/rpc/get_sync_owner`, {
          method: "POST",
          headers: {
            ...authHeaders,
            Authorization: `Bearer ${SessionStore.accessToken}`
          }
        });
      }
    }

    if (!res.ok) {
      if (res.status === 401) {
        await this.signOut();
      }
      throw new Error(await res.text());
    }

    const data = await res.json();
    const id = data;

    this.cachedEffectiveUserId = id;
    // Re-read the subject rather than reusing the one from entry: the 401 retry
    // path above may have swapped in a refreshed token.
    this.cachedEffectiveUserSourceUserId = currentTokenSubject();
    return id;
  }
}

export const AuthManager = new AuthManagerClass();
