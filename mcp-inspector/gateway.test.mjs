import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { configuration, createGateway, oauth, validateToken } from "./gateway.mjs";

const config = configuration({ API_MCP_URL: "https://mcp.example.test/mcp",
  API_DAB_MCP_URL: "https://dab.example.test/mcp", MCP_PROXY_FULL_ADDRESS: "https://inspector.example.test/proxy" });
const seconds = () => Math.floor(Date.now() / 1000);
const claims = (overrides = {}) => ({ sub: "employee-1", app: "adventureworks-inspector", category: "employee",
  roles: ["executive-admin"], scope: "mcp.access products.read", iat: seconds(), exp: seconds() + 600,
  aud: config.targets[0].audience, ...overrides });

async function fixture(t) {
  let time = Date.now(), subject = "employee-1", tokenExpiry = time + 600000;
  const exchanges = [], requests = [], logs = [];
  const authorization = {
    authorizationEndpoint: config.issuerOrigin + "/authorize",
    async exchange(code, verifier, audience) {
      exchanges.push({ code, verifier, audience });
      return validateToken(claims({ sub: subject, aud: audience, iat: Math.floor(time / 1000),
        exp: Math.floor(tokenExpiry / 1000) }),
        "server-held-" + audience, audience, time);
    },
  };
  const gateway = createGateway(config, authorization, { now: () => time, log: value => logs.push(value),
    request: async (target, options) => {
      requests.push({ target, ...options });
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": target.includes("dab.") ? "dab-id" : "mcp-id" } });
    } });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  t.after(() => gateway.close());
  const base = "http://127.0.0.1:" + gateway.server.address().port;
  const call = (path, { cookie, origin, ...options } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: options.method || "GET",
      headers: { Host: new URL(config.origin).host, ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}), ...options.headers } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
  function cookies(response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); }
  async function begin() {
    const response = await call("/auth/login");
    assert.equal(response.status, 303);
    const logout = new URL(response.headers.get("location"));
    assert.equal(logout.pathname, "/logout");
    const authorize = new URL(logout.searchParams.get("returnUrl"), config.issuerOrigin);
    assert.equal(authorize.searchParams.get("client_id"), "adventureworks-inspector");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!authorize.searchParams.get("scope").includes("offline_access"));
    return { authorize, cookie: cookies(response) };
  }
  async function finish(flow) {
    let response;
    for (let index = 0; index < 2; index++) {
      const state = flow.authorize.searchParams.get("state");
      response = await call("/oauth/callback?state=" + state + "&code=code" + index, { cookie: flow.cookie });
      assert.equal(response.status, 303);
      assert.equal(createHash("sha256").update(exchanges.at(-1).verifier).digest("base64url"),
        flow.authorize.searchParams.get("code_challenge"));
      if (index === 0) flow.authorize = new URL(response.headers.get("location"));
    }
    return cookies(response);
  }
  return { call, begin, finish, cookies, requests, exchanges, logs, authorization,
    advance: milliseconds => { time += milliseconds; },
    subject: value => { subject = value; }, expiryAfter: milliseconds => { tokenExpiry = time + milliseconds; } };
}
const proxy = index => "/proxy/mcp?url=" + encodeURIComponent(config.targets[index].url);

test("configuration and internal token checks fail closed on endpoints, categories, roles, app, audience and expiry", () => {
  assert.throws(() => configuration({ API_MCP_URL: "http://mcp.test/mcp" }));
  assert.equal(validateToken(claims(), "private", config.targets[0].audience).role, "executive-admin");
  for (const change of [{ category: "consumer" }, { category: "service" }, { app: "mcp-inspector" },
    { aud: [config.targets[0].audience, config.targets[1].audience] }, { roles: ["consumer"] },
    { roles: ["executive-admin", "manufacturing-engineer"] }, { exp: seconds() - 1 },
    { iat: seconds() + 60 }, { exp: seconds() + 7200 }, { scope: "products.read" },
    { sub: "" }, { category: "manufacturing" }]) {
    assert.throws(() => validateToken(claims(change), "private", config.targets[0].audience));
  }
});

test("real signed JWT verification pins discovery, issuer, signature, audience and first-party application", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: forgedKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let changed = {}, signingKey = privateKey;
  const request = async (target, options) => {
    assert.equal(options.redirect, "error");
    const url = new URL(target);
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({
      issuer: config.issuerOrigin + "/", authorization_endpoint: config.issuerOrigin + "/authorize",
      token_endpoint: config.issuerOrigin + "/token", jwks_uri: config.issuerOrigin + "/jwks",
    });
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    assert.equal(url.href, config.issuerOrigin + "/token");
    const form = options.body;
    assert.equal(form.get("client_id"), "adventureworks-inspector");
    assert.equal(form.get("redirect_uri"), config.origin + "/oauth/callback");
    const token = await new SignJWT(claims({ iss: config.issuerOrigin + "/", ...changed }))
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(signingKey);
    return Response.json({ token_type: "Bearer", access_token: token });
  };
  const authorization = await oauth(config, request);
  assert.equal((await authorization.exchange("code", "verifier", config.targets[0].audience)).subject, "employee-1");
  for (const change of [{ iss: "https://untrusted.test/" }, { aud: config.targets[1].audience },
    { app: "mcp-inspector" }, { exp: seconds() - 1 }, { category: "consumer" }]) {
    changed = change;
    await assert.rejects(authorization.exchange("code", "verifier", config.targets[0].audience));
  }
  changed = {};
  signingKey = forgedKey;
  await assert.rejects(authorization.exchange("code", "verifier", config.targets[0].audience));
  await assert.rejects(oauth(config, async () => Response.json({
    issuer: config.issuerOrigin + "/", authorization_endpoint: "https://evil.test/authorize",
    token_endpoint: config.issuerOrigin + "/token", jwks_uri: config.issuerOrigin + "/jwks",
  })));
});

test("anonymous proxy/assets deny access; PKCE has cookie-bound one-use states and server-held audience tokens", async t => {
  const f = await fixture(t);
  for (const path of ["/proxy/config", "/proxy/health", proxy(0), "/assets/example.js"])
    assert.equal((await f.call(path)).status, 401);
  const flow = await f.begin();
  const first = flow.authorize.searchParams.get("state");
  assert.equal((await f.call("/oauth/callback?state=wrong&code=x", { cookie: flow.cookie })).status, 403);
  assert.equal((await f.call("/oauth/callback?state=" + first + "&code=x")).status, 403);
  const cookie = await f.finish(flow);
  assert.match(cookie, /__Host-aw-inspector=/);
  assert.equal((await f.call("/oauth/callback?state=" + first + "&code=x", { cookie: flow.cookie })).status, 403);
  assert.deepEqual(f.exchanges.map(value => value.audience), config.targets.map(value => value.audience));
  const page = await f.call("/", { cookie });
  assert.match(await page.text(), /iframe/);
  assert.ok(!cookie.includes("server-held"));
});

test("target, Origin, transport and cross-user/target MCP sessions cannot bypass the gateway", async t => {
  const f = await fixture(t), cookie = await f.finish(await f.begin());
  for (const path of ["/proxy/stdio?command=node", "/proxy/sse?url=https://evil.test", "/proxy/message"])
    assert.equal((await f.call(path, { cookie })).status, 404);
  assert.equal((await f.call("/proxy/mcp?url=https://evil.test", { cookie })).status, 403);
  assert.equal((await f.call(proxy(0) + "&transportType=stdio", { cookie })).status, 400);
  assert.equal((await f.call(proxy(0), { cookie, origin: "https://evil.test" })).status, 403);
  assert.equal((await f.call("/auth/logout", { cookie, origin: "null", method: "POST" })).status, 403);
  assert.equal((await f.call(proxy(0), { cookie, method: "POST", body: "{}" })).status, 403);
  assert.equal(f.requests.length, 0);
  const response = await f.call(proxy(0) + "&transportType=streamable-http",
    { cookie, origin: config.origin, method: "POST", body: "{}",
    headers: { Authorization: "Bearer attacker", "X-MS-API-ROLE": "attacker", "X-Custom-Auth-Header": "evil" } });
  assert.equal(response.status, 200);
  await response.text();
  const sent = f.requests.at(-1);
  assert.equal(sent.target, config.targets[0].url);
  assert.equal(sent.redirect, "error");
  assert.equal(sent.headers.Authorization, "Bearer server-held-" + config.targets[0].audience);
  assert.equal(sent.headers["X-MS-API-ROLE"], "executive-admin");
  assert.equal(sent.headers["X-Custom-Auth-Header"], undefined);
  const sessionId = response.headers.get("mcp-session-id");
  assert.equal((await f.call(proxy(1), { cookie, headers: { "Mcp-Session-Id": sessionId } })).status, 403);
  const otherCookie = await f.finish(await f.begin());
  assert.equal((await f.call(proxy(0), { cookie: otherCookie, headers: { "Mcp-Session-Id": sessionId } })).status, 403);
  assert.equal((await f.call(proxy(0), { cookie, headers: { "Mcp-Session-Id": sessionId } })).status, 200);
});

test("logout terminates only owned MCP sessions and rejects cookie reuse; expiry and changed user fail closed", async t => {
  const f = await fixture(t), cookie = await f.finish(await f.begin());
  await (await f.call(proxy(1), { cookie, origin: config.origin, method: "POST", body: "{}" })).text();
  assert.equal((await f.call("/auth/logout", { cookie, method: "POST", origin: "https://evil.test" })).status, 403);
  const response = await f.call("/auth/logout", { cookie, method: "POST", origin: config.origin });
  assert.equal(response.status, 303);
  assert.ok(response.headers.getSetCookie().every(value => value.includes("Max-Age=0")));
  assert.equal((await f.call("/proxy/config", { cookie })).status, 401);
  assert.equal(f.requests.at(-1).method, "DELETE");
  assert.equal(f.requests.at(-1).headers["Mcp-Session-Id"], "dab-id");
  const fresh = await f.finish(await f.begin());
  f.advance(600001);
  assert.equal((await f.call("/proxy/config", { cookie: fresh })).status, 401);
  const expiredFlow = await f.begin();
  f.advance(300001);
  assert.equal((await f.call("/oauth/callback?state=" + expiredFlow.authorize.searchParams.get("state") +
    "&code=x", { cookie: expiredFlow.cookie })).status, 403);
});

test("account switching between resource authorizations cannot create a gateway session", async t => {
  const f = await fixture(t), flow = await f.begin();
  const response = await f.call("/oauth/callback?state=" + flow.authorize.searchParams.get("state") +
    "&code=first", { cookie: flow.cookie });
  f.subject("employee-2");
  const state = new URL(response.headers.get("location")).searchParams.get("state");
  assert.equal((await f.call("/oauth/callback?state=" + state + "&code=second", { cookie: flow.cookie })).status, 403);
  assert.equal((await f.call("/proxy/config", { cookie: flow.cookie })).status, 401);
});

test("hosted client has explicit bounded scale-to-zero request allowances for both targets", async t => {
  const f = await fixture(t), cookie = await f.finish(await f.begin());
  for (const target of ["mcp", "dab"]) {
    const response = await f.call("/?target=" + target, { cookie });
    assert.equal(response.status, 200);
    const html = await response.text();
    const src = html.match(/<iframe title="MCP Inspector" src="([^"]+)"/)?.[1];
    assert.ok(src);
    const url = new URL(src.replaceAll("&amp;", "&"), config.origin);
    assert.equal(url.searchParams.get("MCP_SERVER_REQUEST_TIMEOUT"), "240000");
    assert.equal(url.searchParams.get("MCP_REQUEST_MAX_TOTAL_TIMEOUT"), "240000");
    assert.equal(url.searchParams.get("serverUrl"), config.targets[target === "dab" ? 1 : 0].url);
    assert.equal(url.searchParams.get("MCP_PROXY_FULL_ADDRESS"), config.origin + "/proxy");
  }
});

test("independent user logout and expiry cannot revoke or adopt another user's session", async t => {
  const f = await fixture(t);
  const first = await f.finish(await f.begin());
  f.subject("employee-2");
  f.expiryAfter(900000);
  const second = await f.finish(await f.begin());
  assert.notEqual(first, second);
  assert.equal((await f.call("/proxy/config", { cookie: first })).status, 200);
  assert.equal((await f.call("/proxy/config", { cookie: second })).status, 200);
  await f.call("/auth/logout", { cookie: first, origin: config.origin, method: "POST" });
  assert.equal((await f.call("/proxy/config", { cookie: first })).status, 401);
  assert.equal((await f.call("/proxy/config", { cookie: second })).status, 200);
  f.advance(600001);
  assert.equal((await f.call("/proxy/config", { cookie: second })).status, 200);
  f.advance(300001);
  assert.equal((await f.call("/proxy/config", { cookie: second })).status, 401);
});

test("session expires at the earlier resource token without refresh or identity fallback", async t => {
  const f = await fixture(t), flow = await f.begin();
  f.expiryAfter(120000);
  const response = await f.call("/oauth/callback?state=" + flow.authorize.searchParams.get("state") +
    "&code=first", { cookie: flow.cookie });
  flow.authorize = new URL(response.headers.get("location"));
  f.expiryAfter(600000);
  const completed = await f.call("/oauth/callback?state=" + flow.authorize.searchParams.get("state") +
    "&code=second", { cookie: flow.cookie });
  const cookie = f.cookies(completed);
  assert.equal((await f.call("/proxy/config", { cookie })).status, 200);
  assert.equal(f.exchanges.length, 2);
  f.advance(120001);
  assert.equal((await f.call("/proxy/config", { cookie })).status, 401);
  assert.equal(f.exchanges.length, 2);
  assert.equal(f.requests.length, 0);
});

test("logout during an in-flight OAuth exchange cannot resurrect the abandoned session", async t => {
  const f = await fixture(t), flow = await f.begin();
  let release, started;
  const pendingExchange = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const exchange = f.authorization.exchange;
  f.authorization.exchange = async (...args) => { started(); await pendingExchange; return exchange(...args); };
  const callback = f.call("/oauth/callback?state=" + flow.authorize.searchParams.get("state") +
    "&code=first", { cookie: flow.cookie });
  await entered;
  assert.equal((await f.call("/auth/logout", { cookie: flow.cookie, origin: config.origin, method: "POST" })).status, 303);
  release();
  const response = await callback;
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});
