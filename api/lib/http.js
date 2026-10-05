/* Request and response helpers: JSON bodies with a hard size limit, a single
   error shape, and CORS that names one origin rather than "*" (credentials
   are sent with every API call, and "*" is rejected by the browser then). */

"use strict";

const { config } = require("./env");

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const badRequest = (code, message, extra) =>
  new HttpError(400, code, message, extra);
const unauthorized = (message) =>
  new HttpError(401, "unauthenticated", message || "sign in first");
const forbidden = (message) =>
  new HttpError(403, "forbidden", message || "not allowed");
const notFound = (message) =>
  new HttpError(404, "not_found", message || "not found");
const conflict = (code, message) => new HttpError(409, code, message);
const tooMany = (retryAfter) => {
  const e = new HttpError(429, "rate_limited", "too many requests");
  e.retryAfter = retryAfter;
  return e;
};
const upstream = (service, message) =>
  new HttpError(502, "upstream_error", message || `${service} is unavailable`, {
    service,
  });

/* ------------------------------------------------------------------ cors -- */

// Only the configured site origin may read responses. The dev server and the
// API run on different ports, so this is exercised constantly rather than
// being a production-only code path.
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = new Set([config.siteOrigin]);
  // The dev site is reachable as either loopback spelling; accept both so a
  // developer typing localhost is not met with an opaque CORS failure.
  if (config.siteOrigin.includes("127.0.0.1")) {
    allowed.add(config.siteOrigin.replace("127.0.0.1", "localhost"));
  }
  if (config.siteOrigin.includes("localhost")) {
    allowed.add(config.siteOrigin.replace("localhost", "127.0.0.1"));
  }
  return allowed.has(origin) ? origin : null;
}

function corsHeaders(req) {
  const origin = allowedOrigin(req);
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/* ------------------------------------------------------------- responses -- */

function send(req, res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...corsHeaders(req),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendError(req, res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "internal_error";
  // An unexpected throw must not leak a stack trace or a connection string to
  // the browser, so only known errors carry their message outward.
  const message =
    err instanceof HttpError ? err.message : "something went wrong";
  const payload = { error: { code, message } };
  if (err instanceof HttpError && err.extra) payload.error.details = err.extra;
  const headers = {};
  if (err && err.retryAfter) headers["retry-after"] = String(err.retryAfter);
  if (err && err.closeConnection) headers.connection = "close";
  if (status >= 500) console.error("[error]", err && err.stack ? err.stack : err);
  send(req, res, status, payload, headers);

  /* A request whose body was cut off still has bytes in flight. The response
     is written first, then the socket goes, so the client reads the refusal
     rather than a reset. */
  if (err && err.closeConnection) {
    res.on("finish", () => {
      if (req.socket && !req.socket.destroyed) req.socket.destroy();
    });
  }
}

function redirect(req, res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

/* ------------------------------------------------------------------ body -- */

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] || "");
    if (req.method === "GET" || req.method === "HEAD") return resolve({});
    if (type && !type.includes("application/json")) {
      return reject(badRequest("bad_content_type", "send application/json"));
    }
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        /* Stop reading, but answer before hanging up. Destroying the socket
           here instead would reach the client as a connection reset, which
           looks like a network fault rather than the deliberate refusal it
           is. The socket is closed once the response has been written; see
           closeConnection in sendError. */
        aborted = true;
        req.pause();
        const err = new HttpError(
          413,
          "body_too_large",
          `request body larger than ${MAX_BODY} bytes`
        );
        err.closeConnection = true;
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on("error", () => reject(badRequest("body_read_failed", "could not read the body")));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(badRequest("bad_json", "expected a json object"));
        }
        resolve(parsed);
      } catch (e) {
        reject(badRequest("bad_json", "could not parse the json body"));
      }
    });
  });
}

/* ------------------------------------------------------------- upstream --- */

// One place for every outbound call, so the user agent, the timeout and the
// error shape are identical whoever is calling.
async function fetchJson(url, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 10000);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        accept: "application/json",
        "user-agent": config.userAgent,
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, headers: res.headers, json, text };
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "timed out" : "unreachable";
    return { ok: false, status: 0, headers: null, json: null, text: "", reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  upstream,
  send,
  sendError,
  redirect,
  readJson,
  fetchJson,
  corsHeaders,
  allowedOrigin,
  MAX_BODY,
};
