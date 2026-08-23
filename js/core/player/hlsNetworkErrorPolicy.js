const TERMINAL_HLS_HTTP_STATUSES = new Set([400, 401, 403, 404, 410]);

export function isTerminalHlsHttpStatus(statusCode = 0) {
  return TERMINAL_HLS_HTTP_STATUSES.has(Number(statusCode || 0));
}

export function isRecoverableHlsFragmentTimeout(diagnostic = null) {
  return Boolean(
    diagnostic &&
    diagnostic.fatal === false &&
    String(diagnostic.type || "")
      .trim()
      .toLowerCase() === "networkerror" &&
    String(diagnostic.details || "")
      .trim()
      .toLowerCase() === "fragloadtimeout" &&
    Number(diagnostic.responseCode || 0) === 0 &&
    Number(diagnostic.mediaErrorCode || 0) === 0
  );
}
