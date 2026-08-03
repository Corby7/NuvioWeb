import { httpRequest } from "../../../core/network/httpClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../../../config.js";
import { getSyncOriginClientId } from "./syncOriginClient.js";

// Every sync_push_* / sync_delete_* RPC takes a required p_origin_client_id
// identifying the writing client. PostgREST resolves functions by argument
// names, so omitting it is not a runtime error inside the function — the whole
// call 404s with PGRST202 ("no matches were found in the schema cache") and the
// push is silently lost in each sync service's catch block. Injected here so a
// new push call site cannot forget it.
function withOriginClientId(functionName, body) {
  if (!functionName.startsWith("sync_push_") && !functionName.startsWith("sync_delete_")) {
    return body;
  }
  if (body && body.p_origin_client_id != null) {
    return body;
  }
  return { ...body, p_origin_client_id: getSyncOriginClientId() };
}

function buildHeaders(extra = {}, useSession = true) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    ...extra
  };
  if (!useSession && headers.Authorization == null) {
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }
  return headers;
}

export const SupabaseApi = {
  rpc(functionName, body = {}, useSession = true) {
    return httpRequest(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: buildHeaders({ "Content-Type": "application/json" }, useSession),
      includeSessionAuth: useSession,
      body: JSON.stringify(withOriginClientId(functionName, body))
    });
  },

  select(table, query = "", useSession = true) {
    const suffix = query ? `?${query}` : "";
    return httpRequest(`${SUPABASE_URL}/rest/v1/${table}${suffix}`, {
      method: "GET",
      headers: buildHeaders({}, useSession),
      includeSessionAuth: useSession
    });
  },

  upsert(table, rows, onConflict = null, useSession = true) {
    const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
    return httpRequest(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      method: "POST",
      headers: buildHeaders(
        {
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        useSession
      ),
      includeSessionAuth: useSession,
      body: JSON.stringify(rows)
    });
  },

  delete(table, query, useSession = true) {
    return httpRequest(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: "DELETE",
      headers: buildHeaders({ Prefer: "return=representation" }, useSession),
      includeSessionAuth: useSession
    });
  }
};
