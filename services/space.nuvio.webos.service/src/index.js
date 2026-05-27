var path = require("path");
var https = require("https");
var url = require("url");

var serverHost = require("./serverHost");
var SERVICE_ID = serverHost.SERVICE_ID;
var bootLocalRuntime = serverHost.bootLocalRuntime;
var probeLocalServer = serverHost.probeLocalServer;
var requestActiveServerPath = serverHost.requestActiveServerPath;

var RUNTIME_PATH = path.resolve(__dirname, "..", "runtime", "media-http.cjs");
var DEBRID_REQUEST_TIMEOUT_MS = 15000;
var DEBRID_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
var DEBRID_ALLOWED_HOSTS = {
  "api.torbox.app": true,
  "www.premiumize.me": true,
  "api.real-debrid.com": true
};
var DEBRID_ALLOWED_HEADERS = {
  "authorization": true,
  "content-type": true,
  "accept": true
};
var DEBRID_ALLOWED_METHODS = {
  "GET": true,
  "POST": true,
  "PUT": true,
  "PATCH": true,
  "DELETE": true,
  "HEAD": true
};

function createService() {
  try {
    var Service = require("webos-service");
    return new Service(SERVICE_ID);
  } catch (error) {
    console.warn("[" + SERVICE_ID + "] webos-service unavailable, using local mock:", error.message);
    return {
      register: function() {}
    };
  }
}

var service = createService();

var runtimeState = {
  booted: false,
  bootTimestamp: null,
  error: null
};

function ensureRuntimeStarted() {
  if (runtimeState.booted || runtimeState.error) {
    return;
  }

  runtimeState.bootTimestamp = new Date().toISOString();

  try {
    bootLocalRuntime(RUNTIME_PATH);
    runtimeState.booted = true;
    console.log("[" + SERVICE_ID + "] local media runtime booted from", RUNTIME_PATH);
  } catch (error) {
    runtimeState.error = {
      message: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : "")
    };
    console.error("[" + SERVICE_ID + "] failed to boot local media runtime:", error);
  }
}

function respond(message, payload) {
  if (message && typeof message.respond === "function") {
    message.respond(payload);
    return;
  }

  console.log("[" + SERVICE_ID + "] response:", JSON.stringify(payload));
}

function buildBasePayload() {
  return {
    returnValue: !runtimeState.error,
    serviceId: SERVICE_ID,
    booted: runtimeState.booted,
    bootTimestamp: runtimeState.bootTimestamp,
    runtimePath: RUNTIME_PATH,
    error: runtimeState.error
  };
}

function buildErrorPayload(error, extras) {
  return Object.assign(buildBasePayload(), {
    returnValue: false,
    errorCode: -1,
    errorText: String(error && error.message ? error.message : error || "Unknown service error")
  }, extras || {});
}

function getMessagePayload(message) {
  if (message && message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  return {};
}

function bufferFrom(value) {
  if (Buffer.from) {
    return Buffer.from(String(value == null ? "" : value), "utf8");
  }
  return new Buffer(String(value == null ? "" : value), "utf8");
}

function normalizeHeaderName(name) {
  return String(name || "").trim().toLowerCase();
}

function sanitizeDebridHeaders(headers) {
  var sanitized = {};
  var source = headers && typeof headers === "object" ? headers : {};

  Object.keys(source).forEach(function(name) {
    var normalized = normalizeHeaderName(name);
    var value = source[name];
    if (!DEBRID_ALLOWED_HEADERS[normalized] || value == null) {
      return;
    }

    if (normalized === "authorization") {
      sanitized.Authorization = String(value);
    } else if (normalized === "content-type") {
      sanitized["Content-Type"] = String(value);
    } else if (normalized === "accept") {
      sanitized.Accept = String(value);
    }
  });

  if (!sanitized.Accept) {
    sanitized.Accept = "application/json, text/plain, */*";
  }

  return sanitized;
}

function buildDebridTarget(payload) {
  var baseUrl = String(payload.baseUrl || "").trim();
  var requestPath = String(payload.path || "").trim();
  if (!baseUrl) {
    throw new Error("Missing required parameter: baseUrl");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requestPath) || /^\/\//.test(requestPath)) {
    throw new Error("Debrid proxy path must be relative");
  }

  var targetUrl = baseUrl.replace(/\/+$/, "") + "/" + requestPath.replace(/^\/+/, "");
  var parsed = url.parse(targetUrl);
  var hostname = String(parsed.hostname || "").toLowerCase();

  if (parsed.protocol !== "https:") {
    throw new Error("Debrid proxy only supports HTTPS endpoints");
  }
  if (!DEBRID_ALLOWED_HOSTS[hostname]) {
    throw new Error("Debrid proxy host is not allowed");
  }

  return parsed;
}

function escapeMultipartName(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]/g, " ");
}

function buildMultipartBody(formData, headers) {
  var boundary = "----NuvioDebrid" + Date.now() + Math.floor(Math.random() * 1000000);
  var parts = [];
  var entries = Array.isArray(formData) ? formData : [];

  entries.forEach(function(entry) {
    if (!Array.isArray(entry) || entry.length < 2) {
      return;
    }
    parts.push(bufferFrom("--" + boundary + "\r\n"));
    parts.push(bufferFrom("Content-Disposition: form-data; name=\"" + escapeMultipartName(entry[0]) + "\"\r\n\r\n"));
    parts.push(bufferFrom(entry[1]));
    parts.push(bufferFrom("\r\n"));
  });

  parts.push(bufferFrom("--" + boundary + "--\r\n"));
  headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
  return Buffer.concat(parts);
}

function buildDebridRequestBody(payload, headers) {
  if (String(payload.bodyType || "") === "formData") {
    return buildMultipartBody(payload.formData, headers);
  }

  if (payload.bodyText == null || String(payload.bodyText) === "") {
    return null;
  }

  return bufferFrom(payload.bodyText);
}

function parseResponseBody(text) {
  if (!String(text || "").trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function requestDebridEndpoint(payload, callback) {
  var parsed = buildDebridTarget(payload);
  var method = String(payload.method || "GET").trim().toUpperCase();
  if (!DEBRID_ALLOWED_METHODS[method]) {
    throw new Error("Debrid proxy method is not allowed");
  }

  var headers = sanitizeDebridHeaders(payload.headers);
  var body = buildDebridRequestBody(payload, headers);
  if (body && body.length) {
    headers["Content-Length"] = body.length;
  }

  var options = {
    protocol: "https:",
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: (parsed.pathname || "/") + (parsed.search || ""),
    method: method,
    headers: headers
  };
  var finished = false;
  var request = https.request(options, function(response) {
    var chunks = [];
    var receivedBytes = 0;

    response.on("data", function(chunk) {
      receivedBytes += chunk.length;
      if (receivedBytes > DEBRID_MAX_RESPONSE_BYTES) {
        request.destroy(new Error("Debrid response exceeded " + DEBRID_MAX_RESPONSE_BYTES + " bytes"));
        return;
      }
      chunks.push(chunk);
    });

    response.on("end", function() {
      if (finished) {
        return;
      }
      finished = true;
      var text = Buffer.concat(chunks).toString("utf8");
      callback(null, {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode || 0,
        headers: response.headers || {},
        text: text,
        data: parseResponseBody(text)
      });
    });
  });

  request.setTimeout(DEBRID_REQUEST_TIMEOUT_MS, function() {
    request.destroy(new Error("Debrid request timed out after " + DEBRID_REQUEST_TIMEOUT_MS + "ms"));
  });

  request.on("error", function(error) {
    if (finished) {
      return;
    }
    finished = true;
    callback(error);
  });

  if (body && body.length) {
    request.write(body);
  }
  request.end();
}

function registerCommand(commandName, includeBody) {
  service.register(commandName, function(message) {
    ensureRuntimeStarted();
    probeLocalServer(function(_, status) {
      respond(message, Object.assign(buildBasePayload(), {
        url: status ? "http://127.0.0.1:" + status.port : null,
        settingsReachable: Boolean(status),
        settingsStatusCode: status ? status.statusCode : null,
        settingsBody: includeBody && status ? status.body : null
      }));
    });
  });
}

function registerDebridRequestCommand() {
  service.register("debridRequest", function(message) {
    try {
      requestDebridEndpoint(getMessagePayload(message), function(error, result) {
        if (error) {
          respond(message, buildErrorPayload(error, {
            status: 0
          }));
          return;
        }

        respond(message, Object.assign(buildBasePayload(), {
          returnValue: true,
          ok: Boolean(result.ok),
          status: result.status,
          headers: result.headers,
          text: result.text,
          data: result.data
        }));
      });
    } catch (error) {
      respond(message, buildErrorPayload(error, {
        status: 0
      }));
    }
  });
}

function registerTracksCommand() {
  service.register("tracks", function(message) {
    ensureRuntimeStarted();

    if (runtimeState.error) {
      respond(message, buildErrorPayload(runtimeState.error));
      return;
    }

    var mediaUrl = String(getMessagePayload(message).url || "").trim();
    if (!mediaUrl) {
      respond(message, buildErrorPayload("Missing required parameter: url"));
      return;
    }

    var tracksPath = "/tracks/" + encodeURIComponent(mediaUrl);
    requestActiveServerPath(tracksPath, function(error, status) {
      if (error) {
        respond(message, buildErrorPayload(error, {
          proxiedPath: tracksPath
        }));
        return;
      }

      if (!status || status.statusCode < 200 || status.statusCode >= 300) {
        var statusCode = status ? status.statusCode || 0 : 0;
        respond(message, buildErrorPayload("Track request failed with HTTP " + statusCode, {
          proxiedPath: tracksPath,
          statusCode: statusCode,
          rawBody: status ? status.body || "" : ""
        }));
        return;
      }

      try {
        var tracks = JSON.parse(status.body || "[]");
        respond(message, Object.assign(buildBasePayload(), {
          url: "http://127.0.0.1:" + status.port,
          proxiedPath: tracksPath,
          statusCode: status.statusCode,
          tracks: Array.isArray(tracks) ? tracks : []
        }));
      } catch (parseError) {
        respond(message, buildErrorPayload(parseError, {
          proxiedPath: tracksPath,
          statusCode: status.statusCode,
          rawBody: status.body || ""
        }));
      }
    });
  });
}

ensureRuntimeStarted();
registerCommand("ping", false);
registerCommand("status", true);
registerDebridRequestCommand();
registerTracksCommand();
