import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { beginTrace, createTelemetry } from "./telemetry.mjs";

const CLIENT = "adventureworks-inspector";
const SESSION_COOKIE = "__Host-aw-inspector";
const FLOW_COOKIE = "__Host-aw-inspector-flow";
const SCOPES = "mcp.access products.read sales.read customers.read customers.write inventory.read orders.read " +
  "orders.write manufacturing.read manufacturing.write admin.read admin.write mcp.admin";
const ROLES = new Set(["executive-admin", "sales-admin", "marketing-admin", "inventory-admin",
  "operations-admin", "manufacturing-engineer"]);
const opaque = () => randomBytes(32).toString("base64url");
const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

class GatewayError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const deny = (status, code) => { throw new GatewayError(status, code); };

function https(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Inspector requires canonical HTTPS endpoints");
  return url;
}

export function configuration(env) {
  const mcp = https(env.API_MCP_URL);
  const dab = https(env.API_DAB_MCP_URL);
  const proxy = https(env.MCP_PROXY_FULL_ADDRESS);
  if (mcp.pathname !== "/mcp" || dab.pathname !== "/mcp" || proxy.pathname !== "/proxy" ||
      mcp.origin === dab.origin || proxy.origin === mcp.origin || proxy.origin === dab.origin)
    throw new Error("Inspector requires distinct configured MCP, DAB and gateway endpoints");
  return {
    origin: proxy.origin, issuerOrigin: mcp.origin,
    targets: [
      { name: "AdventureWorks MCP", url: mcp.href, audience: env.MCP_RESOURCE_IDENTIFIER || mcp.href },
      { name: "AdventureWorks DAB", url: dab.href, audience: env.DAB_RESOURCE_IDENTIFIER || mcp.origin + "/dab" },
    ],
  };
}

async function boundedJson(response, maximum = 256 * 1024) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) deny(502, "upstream_response_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { deny(502, "invalid_upstream_json"); }
}

export async function oauth(config, request = fetch) {
  const response = await request(config.issuerOrigin + "/.well-known/openid-configuration", {
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Inspector OAuth discovery failed");
  const discovery = await boundedJson(response);
  const issuer = https(discovery.issuer);
  if (issuer.origin !== config.issuerOrigin || issuer.pathname !== "/" ||
      discovery.authorization_endpoint !== config.issuerOrigin + "/authorize" ||
      discovery.token_endpoint !== config.issuerOrigin + "/token" ||
      https(discovery.jwks_uri).origin !== config.issuerOrigin)
    throw new Error("Inspector rejected unexpected OAuth discovery endpoints");
  const keys = createRemoteJWKSet(new URL(discovery.jwks_uri), {
    [customFetch]: (url, options) => request(url, { ...options, redirect: "error" }),
    timeoutDuration: 10000, cooldownDuration: 30000, cacheMaxAge: 600000,
  });
  return {
    authorizationEndpoint: discovery.authorization_endpoint,
    async exchange(code, verifier, audience) {
      const response = await request(discovery.token_endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT,
          redirect_uri: config.origin + "/oauth/callback", code, code_verifier: verifier, resource: audience }),
      });
      if (!response.ok) deny(403, "oauth_exchange_denied");
      const token = await boundedJson(response);
      if (token.token_type?.toLowerCase() !== "bearer" || typeof token.access_token !== "string" ||
          token.access_token.length > 32768) deny(403, "invalid_oauth_token");
      let payload;
      try {
        ({ payload } = await jwtVerify(token.access_token, keys, {
          issuer: discovery.issuer, audience, algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat", "app", "category"],
        }));
      } catch { deny(403, "invalid_oauth_signature_or_claims"); }
      return validateToken(payload, token.access_token, audience);
    },
  };
}

export function validateToken(payload, accessToken, audience, now = Date.now()) {
  const roles = typeof payload.roles === "string" ? [payload.roles] : payload.roles;
  if (payload.app !== CLIENT || !["employee", "manufacturing"].includes(payload.category) ||
      typeof payload.sub !== "string" || !payload.sub || payload.aud !== audience ||
      !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
      payload.exp * 1000 <= now || payload.iat * 1000 > now || payload.exp - payload.iat > 3600 ||
      !Array.isArray(roles) || roles.length !== 1 || !ROLES.has(roles[0]) ||
      (payload.category === "manufacturing") !== (roles[0] === "manufacturing-engineer") ||
      typeof payload.scope !== "string" || !payload.scope.split(" ").includes("mcp.access"))
    deny(403, "internal_user_token_required");
  return { accessToken, subject: payload.sub, category: payload.category, role: roles[0],
    expires: payload.exp * 1000, name: typeof payload.name === "string" ? payload.name : "Internal user" };
}

function cookie(req, name) {
  const values = (req.headers.cookie || "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(name + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
const setCookie = (name, value, seconds) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;

export function createGateway(config, authorization, { request = fetch, now = Date.now,
  staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "node_modules/@modelcontextprotocol/inspector/client/dist"),
  log = code => console.error("Inspector gateway: " + code), telemetry = null } = {}) {
  const flows = new Map(), sessions = new Map();
  const controllers = new Set();
  function redirect(res, target, cookies) {
    if (cookies) res.setHeader("Set-Cookie", cookies);
    res.writeHead(303, { Location: target }).end();
  }
  function html(res, body) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>AdventureWorks Inspector</title>" +
      "<main><h1>AdventureWorks MCP Inspector</h1>" + body + "</main></html>");
  }
  function revoke(id, session) {
    sessions.delete(id);
    clearTimeout(session.timer);
    session.controller.abort();
    for (const [targetIndex, ids] of session.backendSessions) for (const sessionId of ids) {
      const target = config.targets[targetIndex], token = session.tokens[targetIndex];
      void request(target.url, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: "Bearer " + token.accessToken, "X-MS-API-ROLE": token.role,
          Origin: new URL(target.url).origin, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-03-26" },
      }).then(async response => {
        await response.body?.cancel();
        if (![200, 202, 204, 404, 405, 410].includes(response.status)) log("backend_session_cleanup_denied");
      }).catch(() => log("backend_session_cleanup_failed"));
    }
  }
  function prune() {
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
    for (const [id, session] of sessions) if (session.expires <= now()) revoke(id, session);
  }
  function authorize(flow) {
    flow.state = opaque();
    flow.verifier = opaque();
    const url = new URL(authorization.authorizationEndpoint);
    url.search = new URLSearchParams({ client_id: CLIENT, redirect_uri: config.origin + "/oauth/callback",
      response_type: "code", scope: SCOPES, state: flow.state, resource: config.targets[flow.tokens.length].audience,
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"), code_challenge_method: "S256" });
    return url;
  }
  const server = createServer(async (req, res) => {
    const trace = beginTrace(req.headers.traceparent);
    if (telemetry) {
      const startedAt = Date.now();
      res.once("finish", () => {
        let pathname = "/";
        try { pathname = new URL(req.url, "http://gateway.invalid").pathname; } catch { /* label as asset */ }
        telemetry.track({ method: req.method, pathname, status: res.statusCode, startedAt,
          traceparent: req.headers.traceparent, context: trace });
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      prune();
      if (req.headers.host !== new URL(config.origin).host) deny(400, "invalid_host");
      const url = new URL(req.url, config.origin);
      if (req.headers.origin && req.headers.origin !== config.origin) deny(403, "untrusted_origin");
      if (req.headers["sec-fetch-site"] === "cross-site" && url.pathname !== "/oauth/callback")
        deny(403, "cross_site_request");
      if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== config.origin)
        deny(403, "same_origin_required");
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
        return;
      }
      if (req.method === "GET" && url.pathname === "/auth/login") {
        if (flows.size >= 100 || sessions.size >= 100) deny(503, "session_capacity");
        const oldId = cookie(req, SESSION_COOKIE);
        if (sessions.has(oldId)) revoke(oldId, sessions.get(oldId));
        flows.delete(cookie(req, FLOW_COOKIE));
        const id = opaque(), flow = { expires: now() + 300000, tokens: [] };
        flows.set(id, flow);
        const next = authorize(flow);
        // A new sign-in must not silently restore a different application's SSO user.
        const logout = new URL("/logout", config.issuerOrigin);
        logout.searchParams.set("returnUrl", next.pathname + next.search);
        redirect(res, logout.href, [setCookie(FLOW_COOKIE, id, 300), setCookie(SESSION_COOKIE, "", 0)]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const id = cookie(req, FLOW_COOKIE), flow = flows.get(id);
        if (!flow || !flow.state || url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.get("state") !== flow.state) deny(403, "invalid_oauth_state");
        flow.state = null;
        if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 ||
            !url.searchParams.get("code")) {
          flows.delete(id);
          deny(403, "oauth_authorization_denied");
        }
        let token;
        try {
          token = await authorization.exchange(url.searchParams.get("code"), flow.verifier,
            config.targets[flow.tokens.length].audience);
        } catch (error) {
          flows.delete(id);
          throw error;
        }
        if (flows.get(id) !== flow || flow.expires <= now()) deny(403, "oauth_flow_expired_or_cancelled");
        if (flow.tokens.length && [token.subject, token.category, token.role].join("|") !==
            [flow.tokens[0].subject, flow.tokens[0].category, flow.tokens[0].role].join("|")) {
          flows.delete(id);
          deny(403, "oauth_user_changed");
        }
        flow.tokens.push(token);
        if (flow.tokens.length < config.targets.length) {
          const next = authorize(flow);
          flows.set(id, flow);
          redirect(res, next.href);
          return;
        }
        flows.delete(id);
        const sessionId = opaque(), controller = new AbortController();
        const session = { tokens: flow.tokens, expires: Math.min(...flow.tokens.map(token => token.expires)),
          backendSessions: new Map(), controller };
        if (session.expires <= now() || sessions.size >= 100) deny(403, "session_unavailable");
        session.timer = setTimeout(() => revoke(sessionId, session), session.expires - now());
        session.timer.unref();
        sessions.set(sessionId, session);
        redirect(res, "/", [setCookie(SESSION_COOKIE, sessionId, Math.floor((session.expires - now()) / 1000)),
          setCookie(FLOW_COOKIE, "", 0)]);
        return;
      }
      const sessionId = cookie(req, SESSION_COOKIE), session = sessions.get(sessionId);
      if (req.method === "POST" && url.pathname === "/auth/logout") {
        if (session) revoke(sessionId, session);
        flows.delete(cookie(req, FLOW_COOKIE));
        redirect(res, "/", [setCookie(SESSION_COOKIE, "", 0), setCookie(FLOW_COOKIE, "", 0)]);
        return;
      }
      if (!session) {
        if (req.method === "GET" && url.pathname === "/") {
          html(res, '<p>Internal employee or manufacturing sign-in is required.</p><a href="/auth/login">Sign in</a>');
          return;
        }
        deny(401, "internal_sign_in_required");
      }
      if (req.method === "GET" && ["/proxy/health", "/proxy/config"].includes(url.pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(
          url.pathname.endsWith("/health") ? { status: "ok" } : { defaultEnvironment: {} }));
        return;
      }
      if (url.pathname === "/proxy/mcp" && ["GET", "POST", "DELETE"].includes(req.method)) {
        if (url.searchParams.getAll("url").length !== 1 ||
            [...url.searchParams.keys()].some(key => !["url", "transportType"].includes(key)) ||
            url.searchParams.getAll("transportType").length > 1 ||
            (url.searchParams.has("transportType") && url.searchParams.get("transportType") !== "streamable-http"))
          deny(400, "invalid_target");
        const targetIndex = config.targets.findIndex(target => target.url === url.searchParams.get("url"));
        if (targetIndex < 0) deny(403, "target_not_allowed");
        const target = config.targets[targetIndex], token = session.tokens[targetIndex];
        const backendSessionId = req.headers["mcp-session-id"];
        const ids = session.backendSessions.get(targetIndex) || new Set();
        if (backendSessionId && !ids.has(backendSessionId)) deny(403, "session_not_owned");
        if (ids.size >= 16 && !backendSessionId) deny(429, "too_many_mcp_sessions");
        const headers = { Authorization: "Bearer " + token.accessToken, "X-MS-API-ROLE": token.role,
          Origin: new URL(target.url).origin, Accept: "application/json, text/event-stream" };
        const dependencyTrace = beginTrace(trace.traceparent);
        headers.traceparent = dependencyTrace.traceparent;
        for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id"])
          if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
        let body;
        if (req.method === "POST") {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) deny(413, "mcp_request_too_large");
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
          headers["Content-Type"] = "application/json";
        }
        const controller = new AbortController();
        controllers.add(controller);
        const close = () => controller.abort();
        res.once("close", close);
        const dependencyStartedAt = Date.now();
        let upstreamStatus = 0, dependencyOutcome = "upstream-failure";
        try {
          const upstream = await request(target.url, { method: req.method, headers, body, redirect: "error",
            signal: AbortSignal.any([controller.signal, session.controller.signal, AbortSignal.timeout(300000)]) });
          upstreamStatus = upstream.status;
          const returnedId = upstream.headers.get("mcp-session-id");
          if (returnedId) {
            if (returnedId.length > 256 || !/^[\x21-\x7e]+$/.test(returnedId) ||
                (backendSessionId && returnedId !== backendSessionId)) {
              await upstream.body?.cancel();
              deny(502, "invalid_backend_session");
            }
            if (upstream.ok) {
              ids.add(returnedId);
              session.backendSessions.set(targetIndex, ids);
              res.setHeader("Mcp-Session-Id", returnedId);
            }
          }
          if (req.method === "DELETE" && (upstream.ok || [404, 410].includes(upstream.status)))
            ids.delete(backendSessionId);
          const contentType = upstream.headers.get("content-type");
          if (contentType) res.setHeader("Content-Type", contentType);
          res.writeHead(upstream.status);
          if (upstream.body) {
            const stream = Readable.fromWeb(upstream.body);
            await new Promise((resolve, reject) => {
              stream.once("error", reject);
              res.once("finish", resolve);
              res.once("close", resolve);
              stream.pipe(res);
            });
          } else res.end();
          dependencyOutcome = res.writableFinished ? "completed" : "cancelled";
        } finally {
          telemetry?.dependency?.({ context: dependencyTrace, parent: trace, method: req.method,
            target: target.url, status: upstreamStatus, startedAt: dependencyStartedAt, outcome: dependencyOutcome });
          controllers.delete(controller);
          res.removeListener("close", close);
          controller.abort();
        }
        return;
      }
      if (url.pathname.startsWith("/proxy/")) deny(404, "unsupported_inspector_transport");
      if (!["GET", "HEAD"].includes(req.method)) deny(405, "method_not_allowed");
      if (url.pathname === "/") {
        const target = config.targets[url.searchParams.get("target") === "dab" ? 1 : 0];
        const params = new URLSearchParams({ transport: "streamable-http", serverUrl: target.url,
          MCP_PROXY_FULL_ADDRESS: config.origin + "/proxy",
          MCP_SERVER_REQUEST_TIMEOUT: "240000", MCP_REQUEST_MAX_TOTAL_TIMEOUT: "240000" });
        html(res, `<p>${escape(session.tokens[0].name)} (${escape(session.tokens[0].role)})</p>` +
          '<nav><a href="/?target=mcp">Custom MCP</a> | <a href="/?target=dab">DAB MCP</a></nav>' +
          '<form method="post" action="/auth/logout"><button>Sign out</button></form>' +
          `<iframe title="MCP Inspector" src="/inspector?${escape(params)}" ` +
          'style="width:100%;height:85vh;border:0"></iframe>');
        return;
      }
      const asset = url.pathname === "/inspector" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
      const base = await realpath(staticRoot), path = await realpath(resolve(base, asset));
      if (!path.startsWith(base + sep) || !(await stat(path)).isFile()) deny(404, "asset_not_found");
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
      res.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
      if (req.method === "HEAD") res.end();
      else createReadStream(path).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : error.code === "ENOENT" ? 404 : 502;
      const code = error instanceof GatewayError ? error.message : status === 404 ? "asset_not_found" : "gateway_failure";
      log(code);
      if (res.headersSent) res.destroy();
      else res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: code }));
    }
  });
  return { server, close() {
    for (const controller of controllers) controller.abort();
    for (const [id, session] of sessions) revoke(id, session);
    flows.clear();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration(process.env);
  const telemetry = createTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING, { origin: config.origin });
  const gateway = createGateway(config, await oauth(config), { telemetry });
  gateway.server.listen(6274, "127.0.0.1", () => console.log("Inspector OAuth gateway ready"));
  const stop = () => { void telemetry.flush(); void gateway.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
