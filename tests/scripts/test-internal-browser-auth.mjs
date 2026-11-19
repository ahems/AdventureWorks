import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  dabBrowserReadPolicy, functionsBrowserRequest, newAuthBrowserPage, oauthBrowserRequest,
} from "./auth-browser-network-policy.mjs";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const siteIndex = process.argv.indexOf("--site");
const siteFilter = siteIndex >= 0 ? process.argv[siteIndex + 1] : null;
assert.ok(siteFilter === null || ["admin", "manufacturing"].includes(siteFilter), "Invalid site selection");
const result = {
  checks: [], reads: [], functionsReads: [], mcpReads: [], transport: [], failedRequests: [], anonymousRequests: [],
  blockedMutations: 0, blockedRequests: [], loginAttempts: [], loginDiagnostics: [], raceDiagnostics: [],
  staleTabDiagnostics: [], navigationResponses: [],
  functionsRaceDiagnostics: [], mcpRaceDiagnostics: [], callbackRaceDiagnostics: [],
  tokenOriginViolations: 0, phase: "configuration",
};
const policy = JSON.parse(await readFile(new URL("../auth/browser-policy.json", import.meta.url), "utf8"));
const diagnosticLimitMs = policy.startupReadTimeoutMs + 10000;
result.readPolicy = policy;
const startedAt = performance.now();
let browser, lastLoginResponse = -Infinity;
const check = (name, condition) => {
  result.checks.push({ name, status: condition ? "PASS" : "FAIL" });
  assert.ok(condition, name);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const within = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser race timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const endpoint = (name) => {
  const url = new URL(process.env[name]);
  assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash);
  return url;
};
const sites = [
  { name: "admin", url: "APP_ADMIN_URL", path: "/products",
    tokenKey: "dab_oauth_token", generationKey: "dab_oauth_generation",
    tabGenerationKey: "dab_oauth_tab_generation",
    pkceKey: "dab_oauth_pkce", clientId: "adventureworks-admin",
    refreshLock: "dab-oauth-refresh",
    functionsTokenKey: "fn_oauth_token", mcpTokenKey: "mcp_oauth_token",
    tokenKeys: ["dab_oauth_token", "fn_oauth_token", "mcp_oauth_token"],
    userKey: "adventureworks_admin_user", role: "executive-admin" },
  { name: "manufacturing", url: "APP_MANUFACTURING_URL", path: "/define",
    tokenKey: "mfg_dab_oauth_token", generationKey: "mfg_dab_oauth_generation",
    tabGenerationKey: "mfg_dab_oauth_tab_generation",
    pkceKey: "mfg_dab_oauth_pkce", clientId: "adventureworks-manufacturing",
    refreshLock: "mfg-dab-oauth-refresh",
    functionsTokenKey: "mfg_fn_oauth_token",
    tokenKeys: ["mfg_dab_oauth_token", "mfg_fn_oauth_token"],
    userKey: "adventureworks_manufacturing_user", role: "manufacturing-engineer" },
].filter((site) => siteFilter === null || site.name === siteFilter);

try {
  const mcp = endpoint("API_MCP_URL");
  const dab = endpoint("API_URL");
  const functions = endpoint("API_FUNCTIONS_URL");
  assert.equal(new Set([dab.origin, functions.origin, mcp.origin]).size, 3);
  const allowsDabRead = dabBrowserReadPolicy(
    JSON.parse(await readFile(new URL("../../api/dab-config.json", import.meta.url), "utf8")));
  const allowedTokenOrigins = new Set([dab.origin, functions.origin, mcp.origin]);
  const audience = process.env.DAB_RESOURCE_IDENTIFIER || new URL("/dab", mcp).toString();
  const functionsAudience = process.env.FUNCTIONS_RESOURCE_IDENTIFIER || new URL("/functions", mcp).toString();
  const mcpAudience = mcp.href.replace(/\/$/, "");
  for (const site of sites) {
    site.origin = endpoint(site.url).origin;
  }
  for (const identity of ["admin", "manufacturing"]) {
    assert.ok(process.env[`AUTH_BROWSER_${identity.toUpperCase()}_EMAIL`]);
    assert.ok(process.env[`AUTH_BROWSER_${identity.toUpperCase()}_PASSWORD`]);
  }
  result.phase = "browser-prerequisites";
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
  browser = await chromium.launch({ headless: true });
  for (const site of sites) {
    result.phase = site.name + ":anonymous-gate";
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
    try {
      let dataRequests = 0, blockedMutations = 0, anonymous = true;
      const isProbe = (url) => url.origin === dab.origin && url.pathname === "/api/Product" &&
        url.searchParams.get("$first") === "1";
      const trace = (event, method, started, fields = {}) => {
        if (result.transport.length < 48) result.transport.push({
          site: site.name, phase: result.phase, event, method,
          elapsedMs: Math.round(performance.now() - started), ...fields,
        });
      };
      await context.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url());
        const probe = isProbe(url) && ["GET", "OPTIONS"].includes(request.method());
        const started = performance.now();
        if (probe) trace("route", request.method(), started);
        if (request.headers().authorization && !allowedTokenOrigins.has(url.origin)) {
          result.tokenOriginViolations++;
          await route.abort();
          return;
        }
        if ([dab.origin, functions.origin].includes(url.origin) && anonymous) {
          dataRequests++;
          const service = url.origin === dab.origin ? "dab" : "functions";
          if (!result.anonymousRequests.some((item) =>
            item.site === site.name && item.service === service && item.method === request.method())) {
            result.anonymousRequests.push({ site: site.name, service, method: request.method() });
          }
        }
        let body = null;
        if (url.origin === dab.origin && request.method() === "POST") {
          try { body = request.postDataJSON(); } catch { body = null; }
        }
        const probeRequest = { method: request.method(), url, headers: request.headers(), body };
        const allowed = url.origin === dab.origin ? allowsDabRead(probeRequest) :
          url.origin === functions.origin ? functionsBrowserRequest(probeRequest) :
          url.origin === mcp.origin ? oauthBrowserRequest(probeRequest) : true;
        if (!allowed) {
          blockedMutations++;
          result.blockedMutations++;
          if (result.blockedRequests.length < 20) result.blockedRequests.push({
            site: site.name, phase: result.phase, method: request.method(),
            service: url.origin === dab.origin ? "dab" : url.origin === functions.origin ? "functions" : "oauth-mcp",
            route: url.pathname === "/api/manufacturing/status" ? "manufacturing-status" :
              url.pathname.startsWith("/api/supply/catalog/") ? "supply-catalog" : "other",
          });
          await route.abort();
          return;
        }
        await route.continue();
        if (probe) trace("continued", request.method(), started);
      });
      if (site.name === "admin") {
        await context.route((url) => url.origin === functions.origin &&
          url.pathname === "/api/reporting/dashboard-counts", async (route) => {
          const request = route.request();
          const headers = {
            "Access-Control-Allow-Origin": site.origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type",
          };
          if (request.method() === "OPTIONS" &&
              request.headers()["access-control-request-method"] === "GET") {
            return route.fulfill({ status: 204, headers });
          }
          if (request.method() !== "GET") return route.fallback();
          return route.fulfill({
            status: 200, headers,
            json: { totalProducts: 0, totalCustomers: 0, totalOrders: 0, pendingOrders: 0, reviewsToModerate: 0 },
          });
        });
      }
      let page = await newAuthBrowserPage(context);
      const network = await context.newCDPSession(page);
      const probes = new Map();
      await network.send("Network.enable");
      network.on("Network.requestWillBeSent", ({ requestId, request, timestamp }) => {
        if (!isProbe(new URL(request.url)) || !["GET", "OPTIONS"].includes(request.method)) return;
        const probe = { method: request.method, started: performance.now(), timestamp };
        probes.set(requestId, probe);
        trace("request", probe.method, probe.started);
      });
      network.on("Network.responseReceived", ({ requestId, response }) => {
        const probe = probes.get(requestId);
        if (!probe) return;
        const timingMs = {};
        for (const key of ["dnsStart", "dnsEnd", "connectStart", "connectEnd", "sslStart", "sslEnd",
          "sendStart", "sendEnd", "receiveHeadersStart", "receiveHeadersEnd"]) {
          const value = response.timing?.[key];
          if (Number.isFinite(value) && value >= -1 && value <= diagnosticLimitMs) timingMs[key] = Math.round(value);
        }
        const queued = (response.timing?.requestTime - probe.timestamp) * 1000;
        if (Number.isFinite(queued) && queued >= 0 && queued <= diagnosticLimitMs) timingMs.queued = Math.round(queued);
        trace("response", probe.method, probe.started, {
          status: response.status, timingMs,
          protocol: ["h2", "h3", "http/1.1", "http/1.0"].includes(response.protocol) ? response.protocol : "other",
        });
      });
      network.on("Network.loadingFinished", ({ requestId }) => {
        const probe = probes.get(requestId);
        if (probe) trace("finished", probe.method, probe.started);
        probes.delete(requestId);
      });
      network.on("Network.loadingFailed", ({ requestId, errorText, corsErrorStatus }) => {
        const probe = probes.get(requestId);
        if (probe) trace("failed", probe.method, probe.started, {
          reason: /^net::ERR_[A-Z_]{1,60}$/.test(errorText) ? errorText : "unclassified-network-failure",
          corsFailure: !!corsErrorStatus,
        });
        probes.delete(requestId);
      });
      context.on("requestfailed", (request) => {
        const target = new URL(request.url());
        const service = target.origin === dab.origin ? "dab" : target.origin === functions.origin ? "functions" :
          target.origin === mcp.origin ? "oauth-mcp" : null;
        if (!service || result.failedRequests.length >= 30) return;
        const reason = request.failure()?.errorText || "";
        result.failedRequests.push({ site: site.name, service, phase: result.phase,
          reason: /^net::ERR_[A-Z_]+$/.test(reason) ? reason : "unclassified-network-failure" });
      });
      context.on("response", (response) => {
        const target = new URL(response.url());
        const request = response.request();
        if (result.phase === site.name + ":anonymous-gate" && target.origin === site.origin &&
            ["document", "script"].includes(request.resourceType()) && result.navigationResponses.length < 24) {
          result.navigationResponses.push({
            site: site.name, kind: request.resourceType(), status: response.status(),
          });
        }
        if (!result.phase.includes(":sign-in") || target.origin !== mcp.origin ||
            !["/login", "/authorize", "/token"].includes(target.pathname) ||
            !["GET", "POST"].includes(request.method()) || result.loginDiagnostics.length >= 100) return;
        result.loginDiagnostics.push({ site: site.name, phase: result.phase,
          endpoint: target.pathname.slice(1), method: request.method(), status: response.status() });
      });
      page.setDefaultTimeout(60000);
      await page.goto(site.origin + site.path, {
        waitUntil: "domcontentloaded",
        timeout: policy.startupNavigationTimeoutMs,
      });
      await page.waitForURL(
        (url) => url.origin === site.origin && url.pathname === "/login",
        { timeout: policy.startupNavigationTimeoutMs },
      );
      await page.locator("#email").waitFor({ timeout: policy.startupNavigationTimeoutMs });
      check(site.name + ":anonymous-gate-no-data", dataRequests === 0);
      const signIn = async (targetPage = page, waitForSession = true, identity = site.name) => {
        const previousPhase = result.phase;
        const signInPhase = previousPhase.endsWith(":sign-in") ? previousPhase : previousPhase + ":sign-in";
        result.phase = signInPhase + ":fill";
        await targetPage.locator("#email").fill(process.env[`AUTH_BROWSER_${identity.toUpperCase()}_EMAIL`]);
        await targetPage.locator("#password").fill(process.env[`AUTH_BROWSER_${identity.toUpperCase()}_PASSWORD`]);
        result.phase = signInPhase + ":paced-submit";
        const delay = policy.internalLoginMinimumIntervalMs - (performance.now() - lastLoginResponse);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const loginResponse = targetPage.waitForResponse((response) =>
          new URL(response.url()).origin === mcp.origin && new URL(response.url()).pathname === "/login" &&
          response.request().method() === "POST", { timeout: policy.startupNavigationTimeoutMs });
        result.phase = signInPhase + ":submit";
        await targetPage.getByRole("button", { name: /^sign in$/i }).click();
        const status = (await loginResponse).status();
        lastLoginResponse = performance.now();
        result.loginAttempts.push({
          site: site.name, identity, responseAtMs: Math.round(lastLoginResponse - startedAt), status,
        });
        if (status === 429) throw new Error("login-rate-limited");
        assert.equal(status, 302, "OAuth login did not redirect");
        if (waitForSession) {
          result.phase = signInPhase + ":return";
          await targetPage.waitForURL((url) => url.origin === site.origin && url.pathname === site.path);
          result.phase = signInPhase + ":session";
          await targetPage.waitForFunction(({ tokenKey, userKey, generationKey }) => {
            const generation = localStorage.getItem(generationKey);
            return generation && localStorage.getItem(`${tokenKey}:${generation}`) &&
              localStorage.getItem(`${userKey}:${generation}`);
          }, site);
        }
        result.phase = previousPhase;
      };
      const signOut = async (targetPage = page) => {
        const firstName = await targetPage.evaluate(({ userKey, generationKey }) =>
          JSON.parse(localStorage.getItem(`${userKey}:${localStorage.getItem(generationKey)}`)).firstName, site);
        await targetPage.getByRole("button", { name: new RegExp(firstName) }).first().click();
        await targetPage.getByRole("button", { name: /^sign out$/i }).click();
        await targetPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
      };
      result.phase = site.name + ":wrong-category";
      const wrongIdentity = site.name === "admin" ? "manufacturing" : "admin";
      const expectedDenial = site.name === "admin"
        ? "This portal is restricted to AdventureWorks administrators."
        : "This portal is restricted to AdventureWorks manufacturing staff.";
      let deniedTokenRequests = 0;
      const onDeniedRequest = request => {
        const url = new URL(request.url());
        if (url.origin === mcp.origin && url.pathname === "/token") deniedTokenRequests++;
      };
      page.on("request", onDeniedRequest);
      try {
        await signIn(page, false, wrongIdentity);
        await page.getByRole("alert").getByText(expectedDenial, { exact: true })
          .waitFor({ timeout: policy.startupNavigationTimeoutMs });
        const emptySession = await page.evaluate(({ tokenKeys, userKey, pkceKey }) =>
          Object.keys(localStorage).every(key =>
            !tokenKeys.some(tokenKey => key === tokenKey || key.startsWith(`${tokenKey}:`)) &&
            key !== userKey && !key.startsWith(`${userKey}:`)) &&
          !sessionStorage.getItem(pkceKey), site);
        check(site.name + ":wrong-category-denied",
          new URL(page.url()).pathname === "/login" && emptySession &&
          deniedTokenRequests === 0 && dataRequests === 0);
      } finally {
        page.off("request", onDeniedRequest);
      }
      // The denied callback returns to login without retaining the prior deep link.
      await page.goto(site.origin + site.path, {
        waitUntil: "domcontentloaded",
        timeout: policy.startupNavigationTimeoutMs,
      });
      await page.waitForURL(
        url => url.origin === site.origin && url.pathname === "/login",
        { timeout: policy.startupNavigationTimeoutMs },
      );
      anonymous = false;
      result.phase = site.name + ":interactive-pkce";
      await signIn();
      const sessionState = (targetPage = page) => targetPage.evaluate(({ tokenKey, userKey, generationKey }) => {
        const generation = localStorage.getItem(generationKey);
        const token = JSON.parse(localStorage.getItem(`${tokenKey}:${generation}`));
        const claims = JSON.parse(atob(token.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const user = JSON.parse(localStorage.getItem(`${userKey}:${generation}`));
        return { audience: claims.aud, subject: claims.sub, subjectMatches: user.id === "emp_" + claims.sub,
          role: user.appRole, renewable: !!token.refreshToken,
          pkceCleared: !sessionStorage.getItem("dab_oauth_pkce") && !sessionStorage.getItem("mfg_dab_oauth_pkce") };
      }, site);
      const session = await sessionState();
      check(site.name + ":pkce-resource-role-owner", session.audience === audience &&
        session.role === site.role && typeof session.subject === "string" && !!session.subject &&
        session.subjectMatches && session.renewable && session.pkceCleared);
      if (site.name === "manufacturing") {
        await page.route((url) => url.origin === functions.origin &&
          ["/api/manufacturing/status", "/api/supply/catalog/2147483000"].includes(url.pathname),
          async (route) => {
            if (route.request().method() === "OPTIONS") {
              return route.fulfill({ status: 204, headers: {
                "Access-Control-Allow-Origin": site.origin,
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "authorization, content-type",
              } });
            }
            if (route.request().method() !== "GET") return route.fallback();
            if (new URL(route.request().url()).pathname === "/api/supply/catalog/2147483000") {
              return route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": site.origin }, json: [] });
            }
            await route.fulfill({
              status: 200,
              headers: { "Access-Control-Allow-Origin": site.origin },
              json: {
                isRunning: false, queueDepth: 0, pendingWorkOrders: 0, inProgressWorkOrders: 0,
                completedToday: 0, stalledForMaterials: 1, recentScrapEvents: [], locationLoad: [],
                shortages: [{ workOrderId: 2147483000, productId: 2147483000,
                  productName: "Synthetic session fixture", needed: 10, available: 0,
                  shortfall: 10, lastRetryUtc: null }],
              },
            });
          });
        await page.evaluate(({ generationKey }) => {
          const generation = localStorage.getItem(generationKey);
          sessionStorage.setItem(`reorderAllSubmitted:${generation}`, JSON.stringify({
            ids: [2147483000], totalOrdersPlanned: 1, baselineOrderCount: 0, ts: Date.now(),
          }));
        }, site);
        result.phase = site.name + ":reorder-progress-current-generation";
        await page.goto(site.origin + "/execute?tab=shortages", {
          waitUntil: "domcontentloaded",
          timeout: policy.startupNavigationTimeoutMs,
        });
        await page.getByRole("button", { name: /reordering/i }).waitFor();
        check(site.name + ":reorder-progress-current-generation", true);
        await page.evaluate(() => {
          sessionStorage.setItem("reorderAllSubmitted", JSON.stringify({
            ids: [2147483000], totalOrdersPlanned: 1, baselineOrderCount: 0, ts: Date.now(),
          }));
        });
        await page.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded",
          timeout: policy.startupNavigationTimeoutMs,
        });
      }
      result.phase = site.name + ":real-dab-read";
      const readResource = async (targetPage = page) => {
        const startupEligible = result.phase === site.name + ":real-dab-read";
        const timeoutMs = startupEligible ? policy.startupReadTimeoutMs : policy.renewedReadTimeoutMs;
        const traceId = randomUUID().replace(/-/g, "");
        const parentId = randomUUID().replace(/-/g, "").slice(0, 16);
        const read = await targetPage.evaluate(async ({ base, tokenKey, generationKey, role, traceId, parentId, timeoutMs }) => {
          const started = performance.now();
          const token = JSON.parse(localStorage.getItem(`${tokenKey}:${localStorage.getItem(generationKey)}`));
          const url = new URL("/api/Product", base);
          url.searchParams.set("$first", "1");
          let response, raw;
          try {
            response = await fetch(url, { headers: {
              Authorization: "Bearer " + token.accessToken, "X-MS-API-ROLE": role,
              traceparent: `00-${traceId}-${parentId}-01`,
            }, signal: AbortSignal.timeout(timeoutMs) });
            raw = await response.text();
          } catch (error) {
            return { status: response?.status || 0, valid: false, durationMs: Math.round(performance.now() - started),
              error: error.name === "TimeoutError" ? "timeout" :
                error.name === "AbortError" ? "aborted" : "network" };
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return { status: response.status, valid: false, invalidJson: true,
              durationMs: Math.round(performance.now() - started) };
          }
          return { status: response.status, valid: Array.isArray(body.value) && body.value.length === 1,
            durationMs: Math.round(performance.now() - started) };
        }, { base: dab.origin, tokenKey: site.tokenKey, generationKey: site.generationKey,
          role: site.role, traceId, parentId, timeoutMs });
        result.reads.push({ site: site.name, phase: result.phase, traceId, timeoutMs, startupEligible,
          slow: read.durationMs >= policy.slowReadThresholdMs, ...read });
        return read.status === 200 && read.valid && read.durationMs <= timeoutMs;
      };
      const readFunctionsResource = async (targetPage) => {
        const timeoutMs = policy.renewedReadTimeoutMs;
        const read = await targetPage.evaluate(async ({ base, functionsTokenKey, generationKey, timeoutMs }) => {
          const started = performance.now();
          const token = JSON.parse(localStorage.getItem(`${functionsTokenKey}:${localStorage.getItem(generationKey)}`));
          let response;
          try {
            response = await fetch(new URL("/api/webpubsub/negotiate", base), {
              headers: { Authorization: "Bearer " + token.accessToken },
              signal: AbortSignal.timeout(timeoutMs),
            });
            const body = await response.json();
            return { status: response.status, valid: typeof body.url === "string" &&
              ["wss:", "https:"].includes(new URL(body.url).protocol),
              durationMs: Math.round(performance.now() - started) };
          } catch (error) {
            return { status: response?.status || 0, valid: false, durationMs: Math.round(performance.now() - started),
              error: error.name === "TimeoutError" ? "timeout" :
                error.name === "AbortError" ? "aborted" :
                  error.name === "SyntaxError" ? "invalid-json" : "network-or-invalid-url" };
          }
        }, { base: functions.origin, functionsTokenKey: site.functionsTokenKey,
          generationKey: site.generationKey, timeoutMs });
        result.functionsReads.push({ site: site.name, phase: result.phase, timeoutMs, ...read });
        return read.status === 200 && read.valid && read.durationMs <= timeoutMs;
      };
      const readMcpResource = async (targetPage, subject) => {
        const timeoutMs = policy.renewedReadTimeoutMs;
        const chatObserved = deferred();
        const message = "Authentication assurance local fixture";
        const chatEndpoint = (url) => url.origin === functions.origin && url.pathname === "/api/agent/chat";
        const stubChat = async (route) => {
          const request = route.request();
          const headers = {
            "Access-Control-Allow-Origin": site.origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type",
          };
          if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
          let authorization = null;
          try {
            const body = request.postDataJSON();
            const header = request.headers().authorization;
            const token = /^Bearer (\S+)$/i.exec(header || "")?.[1];
            const claims = token && JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
            if (request.method() === "POST" && body?.message === message && body?.isAdmin === true &&
                claims?.aud === mcpAudience && claims?.sub === subject) authorization = header;
          } catch {
            authorization = null;
          }
          if (!authorization) {
            result.blockedMutations++;
            chatObserved.resolve(null);
            return route.abort();
          }
          await route.fulfill({
            status: 200, headers,
            json: { response: "Local assurance fixture", suggestedQuestions: [], toolsUsed: [] },
          });
          chatObserved.resolve(authorization);
        };
        await targetPage.route(chatEndpoint, stubChat);
        const started = performance.now();
        let status = 0, valid = false, error = null;
        try {
          await targetPage.goto(site.origin + "/", {
            waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
          });
          const input = targetPage.getByPlaceholder("Ask about customers, orders, products...");
          await input.fill(message);
          await input.press("Enter");
          const authorization = await within(chatObserved.promise, timeoutMs);
          if (authorization) {
            const response = await context.request.post(mcp.href, {
              headers: { Authorization: authorization, Accept: "application/json, text/event-stream" },
              data: { jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name: "get_product_availability", arguments: { productId: 0 } } },
              timeout: timeoutMs, maxRedirects: 0, maxRetries: 0,
            });
            status = response.status();
            const raw = await response.text();
            const frames = raw.trim().startsWith("{") ? [JSON.parse(raw)] :
              raw.split("\n").filter((line) => line.startsWith("data:"))
                .map((line) => JSON.parse(line.slice(5).trim()));
            const document = frames.at(-1), payload = document?.result;
            valid = status === 200 && !document?.error && payload?.isError !== true &&
              Array.isArray(payload?.content) && payload.content.some((item) =>
                item?.type === "text" && typeof item.text === "string" && item.text.length > 0);
          } else error = "invalid-local-chat";
        } catch (failure) {
          error = failure.name === "TimeoutError" || /timed out/i.test(failure.message) ? "timeout" :
            failure.name === "SyntaxError" ? "invalid-json" : "network-or-browser";
        } finally {
          await targetPage.unroute(chatEndpoint, stubChat);
        }
        const durationMs = Math.round(performance.now() - started);
        result.mcpReads.push({
          site: site.name, phase: result.phase, status, valid, durationMs, timeoutMs, ...(error ? { error } : {}),
        });
        return valid && durationMs <= timeoutMs;
      };
      check(site.name + ":resource-server-read", await readResource());
      result.phase = site.name + ":renewal";
      await page.evaluate(({ tokenKey, generationKey }) => {
        const key = `${tokenKey}:${localStorage.getItem(generationKey)}`;
        const token = JSON.parse(localStorage.getItem(key));
        token.expiresAt = Math.floor(Date.now() / 1000) - 1;
        localStorage.setItem(key, JSON.stringify(token));
      }, site);
      const refreshed = page.waitForResponse((response) =>
        new URL(response.url()).origin === mcp.origin && new URL(response.url()).pathname === "/token" &&
        new URLSearchParams(response.request().postData() || "").get("grant_type") === "refresh_token");
      await page.reload({ waitUntil: "domcontentloaded" });
      check(site.name + ":real-refresh-exchange", (await refreshed).status() === 200);
      await page.waitForFunction(({ tokenKey, generationKey }) => {
        const token = JSON.parse(localStorage.getItem(`${tokenKey}:${localStorage.getItem(generationKey)}`) || "null");
        return token?.expiresAt > Math.floor(Date.now() / 1000);
      }, site);
      check(site.name + ":renewal-preserves-route", new URL(page.url()).pathname === site.path);
      const renewed = await sessionState();
      check(site.name + ":renewal-resource-role-owner", renewed.audience === audience &&
        renewed.role === site.role && renewed.subjectMatches && renewed.renewable && renewed.pkceCleared);
      check(site.name + ":renewed-resource-server-read", await readResource());
      result.phase = site.name + ":same-origin-second-tab";
      const secondPage = await newAuthBrowserPage(context);
      try {
        secondPage.setDefaultTimeout(60000);
        await secondPage.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded",
          timeout: policy.startupNavigationTimeoutMs,
        });
        await secondPage.waitForURL(
          (url) => url.origin === site.origin && url.pathname === site.path,
          { timeout: policy.startupNavigationTimeoutMs },
        );
        await secondPage.waitForFunction(({ tokenKey, userKey, generationKey }) => {
          const generation = localStorage.getItem(generationKey);
          return generation && localStorage.getItem(`${tokenKey}:${generation}`) &&
            localStorage.getItem(`${userKey}:${generation}`);
        }, site);
        const secondSession = await sessionState(secondPage);
        check(site.name + ":same-origin-second-tab-owner",
          secondSession.audience === audience && secondSession.role === site.role &&
          secondSession.subjectMatches && secondSession.subject === session.subject &&
          secondSession.renewable && secondSession.pkceCleared);
        check(site.name + ":same-origin-second-tab-resource-read", await readResource(secondPage));

        const oldGeneration = await page.evaluate(({ generationKey }) => localStorage.getItem(generationKey), site);
        result.phase = site.name + ":cross-tab-logout";
        await signOut();
        await secondPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
        check(site.name + ":same-origin-second-tab-signout", true);
        const cleared = await page.evaluate(({ userKey, generationKey }) => {
          const tokenKeys = ["dab_oauth_token", "mcp_oauth_token", "fn_oauth_token",
            "mfg_dab_oauth_token", "mfg_fn_oauth_token"];
          const generation = localStorage.getItem(generationKey);
          return !localStorage.getItem(`${userKey}:${generation}`) &&
            tokenKeys.every((key) => !localStorage.getItem(key) &&
              !localStorage.getItem(`${key}:${generation}`) && !sessionStorage.getItem(key));
        }, site);
        check(site.name + ":logout-clears-resource-sessions", cleared);

        let staleTabRequests = 0;
        secondPage.on("request", (request) => {
          const target = new URL(request.url());
          if (target.origin !== dab.origin && target.origin !== functions.origin) return;
          staleTabRequests++;
          if (result.staleTabDiagnostics.length < 20) result.staleTabDiagnostics.push({
            site: site.name, phase: result.phase,
            service: target.origin === dab.origin ? "dab" : "functions",
            route: target.pathname.startsWith("/graphql") ? "graphql" :
              target.pathname === "/api/webpubsub/negotiate" ? "webpubsub-negotiate" : "other",
            method: request.method(), authenticated: !!request.headers().authorization,
          });
        });
        result.phase = site.name + ":same-user-new-generation";
        await page.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded",
          timeout: policy.startupNavigationTimeoutMs,
        });
        await page.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
        await signIn();
        const newGeneration = await page.evaluate(({ generationKey }) => localStorage.getItem(generationKey), site);
        const newSession = await sessionState();
        check(site.name + ":same-user-new-generation-owner",
          !!oldGeneration && !!newGeneration && newGeneration !== oldGeneration &&
          newSession.audience === audience && newSession.role === site.role &&
          newSession.subjectMatches && newSession.subject === session.subject &&
          newSession.renewable && newSession.pkceCleared);
        check(site.name + ":same-user-new-generation-resource-read", await readResource());
        if (site.name === "manufacturing") {
          result.phase = site.name + ":reorder-progress-new-generation";
          await page.goto(site.origin + "/execute?tab=shortages", {
            waitUntil: "domcontentloaded",
            timeout: policy.startupNavigationTimeoutMs,
          });
          await page.getByRole("button", { name: /re-order selected/i }).waitFor();
          check(site.name + ":reorder-progress-isolated-after-login",
            await page.getByRole("button", { name: /reordering/i }).count() === 0);
        }

        result.phase = site.name + ":stale-second-tab-no-adoption";
        await secondPage.reload({ waitUntil: "domcontentloaded" });
        await secondPage.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded",
          timeout: policy.startupNavigationTimeoutMs,
        });
        await secondPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
        check(site.name + ":stale-second-tab-no-adoption", staleTabRequests === 0);
      } finally {
        await secondPage.close();
      }
      result.phase = site.name + ":logout";
      await signOut();
      await page.close();
      page = await newAuthBrowserPage(context);
      page.setDefaultTimeout(60000);
      anonymous = true;
      dataRequests = 0;
      await page.goto(site.origin + site.path, {
        waitUntil: "domcontentloaded",
        timeout: policy.startupNavigationTimeoutMs,
      });
      await page.waitForURL(
        (url) => url.origin === site.origin && url.pathname === "/login",
        { timeout: policy.startupNavigationTimeoutMs },
      );
      check(site.name + ":logout-gates-deep-link", dataRequests === 0);

      for (const [kind, mode, expectedStatus] of [
        ["dab", "success", 200], ["dab", "rejected", 400],
        ["functions", "success", 200], ["functions", "rejected", 400],
        ...(site.name === "admin" ? [["mcp", "success", 200], ["mcp", "rejected", 400]] : []),
      ]) {
        const race = site.name + ":concurrent-" + (kind === "dab" ? "refresh" : kind) + "-" + mode;
        const targetAudience = kind === "dab" ? audience : kind === "functions" ? functionsAudience : mcpAudience;
        const diagnostics = kind === "dab" ? result.raceDiagnostics :
          kind === "functions" ? result.functionsRaceDiagnostics : result.mcpRaceDiagnostics;
        result.phase = race + ":navigate-login";
        anonymous = false;
        await page.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
        });
        await page.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
        result.phase = race + ":sign-in";
        await signIn();
        const stalePage = page;
        const freshPage = await newAuthBrowserPage(context);
        freshPage.setDefaultTimeout(60000);
        const captured = deferred(), release = deferred(), delivered = deferred();
        const tokenEndpoint = (url) => url.origin === mcp.origin && url.pathname === "/token";
        let capturedTarget = false, reloadCommitted = false;
        let staleChatRequests = 0;
        const onStaleRequest = (request) => {
          const target = new URL(request.url());
          if (target.origin === functions.origin && target.pathname === "/api/agent/chat") staleChatRequests++;
        };
        if (kind === "mcp") stalePage.on("request", onStaleRequest);
        const onNavigation = (frame) => {
          if (frame === stalePage.mainFrame()) reloadCommitted = true;
        };
        const diagnose = (event, status) => {
          const last = diagnostics.at(-1);
          if (last?.site === site.name && last?.mode === mode && last?.event === event && status === undefined) {
            last.count = (last.count || 1) + 1;
          } else if (diagnostics.length < 48) {
            diagnostics.push({ site: site.name, mode, event, ...(status === undefined ? {} : { status }) });
          }
        };
        const holdRefresh = async (route) => {
          const request = route.request();
          const form = new URLSearchParams(request.postData() || "");
          if (request.method() !== "POST" || form.get("grant_type") !== "refresh_token") {
            return route.fallback();
          }
          if (!reloadCommitted) {
            diagnose("pre-reload-refresh-aborted");
            return route.abort();
          }
          if (form.get("resource") !== targetAudience || capturedTarget) {
            diagnose("other-refresh-aborted");
            return route.abort();
          }
          capturedTarget = true;
          diagnose("target-refresh-started");
          try {
            const response = await route.fetch({ timeout: 60000, maxRetries: 0, maxRedirects: 0 });
            diagnose("response-captured", response.status());
            captured.resolve(response.status());
            await release.promise;
            await route.fulfill({ response });
            diagnose("response-delivered");
            delivered.resolve(true);
          } catch {
            diagnose("route-failed");
            captured.resolve(0);
            delivered.resolve(false);
            try {
              await route.abort();
            } catch {
              result.checks.push({ name: site.name + ":race-route-abort", status: "FAIL" });
            }
          }
        };
        const holdOtherTabRefresh = async (route) => {
          const request = route.request();
          const form = new URLSearchParams(request.postData() || "");
          if (request.method() === "POST" && form.get("grant_type") === "refresh_token") {
            diagnose("control-refresh-aborted");
            return route.abort();
          }
          return route.fallback();
        };
        try {
          result.phase = race + ":second-tab";
          // Keep unrelated fresh-tab renewals from rotating the snapshot during stale-response checks.
          await freshPage.route(tokenEndpoint, holdOtherTabRefresh);
          await freshPage.goto(site.origin + site.path, {
            waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
          });
          await freshPage.waitForURL((url) => url.origin === site.origin && url.pathname === site.path);
          const oldGeneration = await stalePage.evaluate(({ generationKey }) => localStorage.getItem(generationKey), site);
          const oldSession = await sessionState(stalePage);
          await stalePage.addInitScript(({ tokenUrl, resource, refreshLock }) => {
            const originalFetch = window.fetch;
            window.fetch = async (input, init) => {
              const target = typeof input === "string" ? input : input.url;
              const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
              const response = await originalFetch(input, init);
              if (target === tokenUrl && form.get("grant_type") === "refresh_token" &&
                  form.get("resource") === resource) {
                window.__awRaceResponseStatus = response.status;
              }
              return response;
            };
            if (navigator.locks?.request) {
              const originalRequest = navigator.locks.request.bind(navigator.locks);
              navigator.locks.request = (name, ...args) => {
                if (name !== refreshLock || args.length !== 1 || typeof args[0] !== "function") {
                  return originalRequest(name, ...args);
                }
                return originalRequest(name, async (lock) => {
                  try {
                    const value = await args[0](lock);
                    if (window.__awRaceResponseStatus !== undefined && !window.__awRaceHandlerFinished) {
                      window.__awRaceHandlerReturnedNull = value === null;
                      window.__awRaceHandlerFinished = true;
                    }
                    return value;
                  } catch (error) {
                    if (window.__awRaceResponseStatus !== undefined && !window.__awRaceHandlerFinished) {
                      window.__awRaceHandlerReturnedNull = false;
                      window.__awRaceHandlerFinished = true;
                    }
                    throw error;
                  }
                });
              };
              window.__awRaceLockAvailable = true;
            }
          }, { tokenUrl: mcp.origin + "/token", resource: targetAudience, refreshLock: site.refreshLock });
          await stalePage.route(tokenEndpoint, holdRefresh);
          stalePage.on("framenavigated", onNavigation);
          await stalePage.evaluate(({ tokenKey, functionsTokenKey, mcpTokenKey, generationKey, kind, mode }) => {
            const generation = localStorage.getItem(generationKey);
            const key = `${tokenKey}:${generation}`;
            const token = JSON.parse(localStorage.getItem(key));
            if (kind === "dab") token.expiresAt = Math.floor(Date.now() / 1000) - 1;
            else localStorage.removeItem(`${kind === "functions" ? functionsTokenKey : mcpTokenKey}:${generation}`);
            if (mode === "rejected") token.refreshToken = "invalid-auth-assurance-refresh";
            localStorage.setItem(key, JSON.stringify(token));
          }, { ...site, kind, mode });
          result.phase = race + ":reload";
          if (kind === "mcp") {
            await stalePage.goto(site.origin + "/", {
              waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
            });
          } else {
            await stalePage.reload({ waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs });
          }
          assert.ok(await stalePage.evaluate(() => window.__awRaceLockAvailable === true));
          const fixtureReady = await stalePage.evaluate(({ tokenKey, functionsTokenKey, mcpTokenKey, generationKey, kind }) => {
            const generation = localStorage.getItem(generationKey);
            const token = JSON.parse(localStorage.getItem(`${tokenKey}:${generation}`) || "null");
            return kind === "dab" ? !!token && token.expiresAt <= Math.floor(Date.now() / 1000) :
              !!token && !localStorage.getItem(`${kind === "functions" ? functionsTokenKey : mcpTokenKey}:${generation}`);
          }, { ...site, kind });
          diagnose(fixtureReady ? "fixture-ready" : "fixture-not-ready");
          if (kind === "mcp") {
            const input = stalePage.getByPlaceholder("Ask about customers, orders, products...");
            await input.fill("Authentication assurance stale fixture");
            await input.press("Enter");
          }
          result.phase = race + ":capture";
          check(race + "-server-response", await within(captured.promise, policy.renewedReadTimeoutMs) === expectedStatus);

          result.phase = race + ":logout";
          await signOut(freshPage);
          await stalePage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
          await freshPage.goto(site.origin + site.path, {
            waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
          });
          await freshPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
          result.phase = race + ":new-session";
          await signIn(freshPage);
          const newSession = await sessionState(freshPage);
          const snapshotValid = await freshPage.evaluate(({ tokenKeys, userKey, generationKey, oldGeneration }) => {
            const generation = localStorage.getItem(generationKey);
            const tokens = tokenKeys.map((key) => localStorage.getItem(`${key}:${generation}`));
            const user = localStorage.getItem(`${userKey}:${generation}`);
            window.__awRaceSnapshot = { generation, tokens, user };
            return !!generation && generation !== oldGeneration && !!tokens[0] && !!user &&
              tokenKeys.every((key) => !localStorage.getItem(`${key}:${oldGeneration}`));
          }, { ...site, oldGeneration });
          assert.ok(snapshotValid && newSession.subject === oldSession.subject && newSession.role === site.role);

          result.phase = race + ":delivery";
          release.resolve();
          assert.ok(await within(delivered.promise, policy.renewedReadTimeoutMs));
          await stalePage.waitForFunction((status) =>
            window.__awRaceResponseStatus === status && window.__awRaceHandlerFinished === true, expectedStatus,
            { timeout: policy.renewedReadTimeoutMs });
          const ignored = await stalePage.evaluate(() => window.__awRaceHandlerReturnedNull === true);
          diagnose(ignored ? "handler-returned-null" : "handler-returned-other");
          const preserved = await freshPage.evaluate(({ tokenKeys, userKey, generationKey, oldGeneration }) => {
            const snapshot = window.__awRaceSnapshot;
            return localStorage.getItem(generationKey) === snapshot.generation &&
              tokenKeys.every((key, index) =>
                localStorage.getItem(`${key}:${snapshot.generation}`) === snapshot.tokens[index] &&
                !localStorage.getItem(`${key}:${oldGeneration}`)) &&
              localStorage.getItem(`${userKey}:${snapshot.generation}`) === snapshot.user &&
              localStorage.getItem(`${generationKey}:revoked:${oldGeneration}`) === "1";
          }, { ...site, oldGeneration });
          const staleGated = await stalePage.evaluate(({ tabGenerationKey, oldGeneration }) =>
            location.pathname === "/login" &&
            JSON.parse(sessionStorage.getItem(tabGenerationKey)) === oldGeneration, { ...site, oldGeneration });
          diagnose(preserved ? "new-session-preserved" : "new-session-changed");
          diagnose(staleGated ? "stale-tab-gated" : "stale-tab-ungated");
          if (kind === "mcp") {
            await stalePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
            diagnose(staleChatRequests === 0 ? "stale-chat-not-sent" : "stale-chat-sent");
          }
          check(race + "-stale-response-ignored",
            ignored && preserved && staleGated && (kind !== "mcp" || staleChatRequests === 0));
          await freshPage.unroute(tokenEndpoint, holdOtherTabRefresh);
          if (kind === "functions" || kind === "mcp") {
            result.phase = race + ":fresh-functions-session";
            await freshPage.reload({ waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs });
            await freshPage.waitForURL((url) => url.origin === site.origin && url.pathname === site.path);
            await freshPage.waitForFunction(({ functionsTokenKey, generationKey, functionsAudience, subject }) => {
              const raw = localStorage.getItem(`${functionsTokenKey}:${localStorage.getItem(generationKey)}`);
              if (!raw) return false;
              const token = JSON.parse(raw);
              const claims = JSON.parse(atob(token.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
              return claims.aud === functionsAudience && claims.sub === subject && token.subject === subject;
            }, { ...site, functionsAudience, subject: newSession.subject }, { timeout: policy.renewedReadTimeoutMs });
          }
          result.phase = race;
          const dabRead = await readResource(freshPage);
          const functionsRead = kind === "dab" || await readFunctionsResource(freshPage);
          const mcpRead = kind !== "mcp" || await readMcpResource(freshPage, newSession.subject);
          check(race + "-new-session-read", dabRead && functionsRead && mcpRead);
          await signOut(freshPage);
        } finally {
          release.resolve();
          stalePage.off("framenavigated", onNavigation);
          stalePage.off("request", onStaleRequest);
          await stalePage.unroute(tokenEndpoint, holdRefresh);
          await freshPage.unroute(tokenEndpoint, holdOtherTabRefresh);
          await freshPage.close();
          await stalePage.close();
        }
        page = await newAuthBrowserPage(context);
        page.setDefaultTimeout(60000);
      }
      for (const [mode, expectedStatus] of [["success", 200], ["rejected", 400]]) {
        const race = site.name + ":concurrent-callback-" + mode;
        result.phase = race + ":navigate-login";
        anonymous = false;
        await page.goto(site.origin + site.path, {
          waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
        });
        await page.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
        const stalePage = page;
        const freshPage = await newAuthBrowserPage(context);
        freshPage.setDefaultTimeout(60000);
        const captured = deferred(), release = deferred(), delivered = deferred();
        const tokenEndpoint = (url) => url.origin === mcp.origin && url.pathname === "/token";
        let capturedTarget = false;
        const diagnose = (event, status) => {
          if (result.callbackRaceDiagnostics.length < 48) {
            result.callbackRaceDiagnostics.push({
              site: site.name, mode, event, ...(status === undefined ? {} : { status }),
            });
          }
        };
        const holdCallback = async (route) => {
          const request = route.request();
          const form = new URLSearchParams(request.postData() || "");
          if (request.method() !== "POST" || form.get("grant_type") !== "authorization_code") {
            return route.fallback();
          }
          if (capturedTarget || form.get("client_id") !== site.clientId ||
              form.get("resource") !== audience ||
              form.get("redirect_uri") !== site.origin + "/oauth/callback" ||
              !form.get("code") || !form.get("code_verifier")) {
            diagnose("unexpected-code-request");
            captured.resolve(0);
            return route.abort();
          }
          capturedTarget = true;
          diagnose("authorization-code-started");
          try {
            const options = { timeout: 60000, maxRetries: 0, maxRedirects: 0 };
            if (mode === "rejected") {
              const invalidVerifier = "auth-assurance-invalid-" + "0".repeat(43);
              assert.notEqual(form.get("code_verifier"), invalidVerifier);
              form.set("code_verifier", invalidVerifier);
              options.postData = form.toString();
            }
            const response = await route.fetch(options);
            diagnose("response-captured", response.status());
            captured.resolve(response.status());
            await release.promise;
            await route.fulfill({ response });
            diagnose("response-delivered");
            delivered.resolve(true);
          } catch {
            diagnose("route-failed");
            captured.resolve(0);
            delivered.resolve(false);
            try {
              await route.abort();
            } catch {
              result.checks.push({ name: site.name + ":callback-route-abort", status: "FAIL" });
            }
          }
        };
        const holdOtherTabRefresh = async (route) => {
          const request = route.request();
          const form = new URLSearchParams(request.postData() || "");
          if (request.method() === "POST" && form.get("grant_type") === "refresh_token") {
            return route.abort();
          }
          return route.fallback();
        };
        try {
          await freshPage.route(tokenEndpoint, holdOtherTabRefresh);
          await freshPage.goto(site.origin + site.path, {
            waitUntil: "domcontentloaded", timeout: policy.startupNavigationTimeoutMs,
          });
          await freshPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
          await stalePage.route(tokenEndpoint, holdCallback);
          result.phase = race + ":sign-in";
          await signIn(stalePage, false);
          result.phase = race + ":capture";
          check(race + "-server-response", await within(captured.promise, policy.renewedReadTimeoutMs) === expectedStatus);
          await stalePage.waitForURL((url) => url.origin === site.origin && url.pathname === "/oauth/callback");
          const oldGeneration = await stalePage.evaluate(({ generationKey }) => localStorage.getItem(generationKey), site);
          assert.ok(oldGeneration);

          result.phase = race + ":new-session";
          await signIn(freshPage);
          const newSession = await sessionState(freshPage);
          const snapshotValid = await freshPage.evaluate(({ tokenKeys, userKey, generationKey, oldGeneration }) => {
            const generation = localStorage.getItem(generationKey);
            const tokens = tokenKeys.map((key) => localStorage.getItem(`${key}:${generation}`));
            const user = localStorage.getItem(`${userKey}:${generation}`);
            window.__awCallbackSnapshot = { generation, tokens, user };
            return !!generation && generation !== oldGeneration && !!tokens[0] && !!user &&
              tokenKeys.every((key) => !localStorage.getItem(`${key}:${oldGeneration}`));
          }, { ...site, oldGeneration });
          assert.ok(snapshotValid && newSession.subject === session.subject && newSession.role === site.role);

          result.phase = race + ":delivery";
          release.resolve();
          assert.ok(await within(delivered.promise, policy.renewedReadTimeoutMs));
          await stalePage.getByText("Sign-in was superseded.", { exact: true })
            .waitFor({ timeout: policy.renewedReadTimeoutMs });
          diagnose("callback-superseded");
          const preserved = await freshPage.evaluate(({ tokenKeys, userKey, generationKey, oldGeneration }) => {
            const snapshot = window.__awCallbackSnapshot;
            return localStorage.getItem(generationKey) === snapshot.generation &&
              tokenKeys.every((key, index) =>
                localStorage.getItem(`${key}:${snapshot.generation}`) === snapshot.tokens[index] &&
                !localStorage.getItem(`${key}:${oldGeneration}`)) &&
              localStorage.getItem(`${userKey}:${snapshot.generation}`) === snapshot.user &&
              !localStorage.getItem(`${userKey}:${oldGeneration}`) &&
              localStorage.getItem(`${generationKey}:revoked:${oldGeneration}`) === "1";
          }, { ...site, oldGeneration });
          const staleGated = await stalePage.evaluate(({ tabGenerationKey, pkceKey, oldGeneration }) =>
            location.pathname === "/oauth/callback" && !sessionStorage.getItem(pkceKey) &&
            JSON.parse(sessionStorage.getItem(tabGenerationKey)) === oldGeneration, { ...site, oldGeneration });
          check(race + "-stale-response-ignored", preserved && staleGated);
          result.phase = race;
          check(race + "-new-session-read", await readResource(freshPage));
          await signOut(freshPage);
        } finally {
          release.resolve();
          await stalePage.unroute(tokenEndpoint, holdCallback);
          await freshPage.unroute(tokenEndpoint, holdOtherTabRefresh);
          await freshPage.close();
          await stalePage.close();
        }
        page = await newAuthBrowserPage(context);
        page.setDefaultTimeout(60000);
      }
      check(site.name + ":no-business-mutations", blockedMutations === 0);
      check(site.name + ":no-token-to-untrusted-origin", result.tokenOriginViolations === 0);
    } finally {
      await context.close();
    }
  }
  result.phase = "complete";
} catch (error) {
  result.error = {
    name: error.name,
    operation: result.phase.endsWith(":anonymous-gate") ? "anonymous-deep-link-navigation" : "browser-flow",
    category: error.message === "login-rate-limited" ? "rate-limited" :
      error.name === "TimeoutError" || /timeout|timed out/i.test(error.message) ? "timeout" :
      /Failed to fetch|NetworkError/.test(error.message) ? "network" :
      /Execution context was destroyed|navigation/.test(error.message) ? "navigation" :
      /aborted|AbortError/i.test(error.message) ? "aborted" :
      /ReferenceError/.test(error.message) ? "javascript-reference" :
      /TypeError/.test(error.message) ? "javascript-type" : "assertion-or-browser",
  };
  result.checks.push({ name: result.phase,
    status: result.phase === "browser-prerequisites" ? "BLOCKED" : "FAIL" });
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  }
  console.log("Internal browser auth: " + result.phase + "; " + result.checks.length + " sanitized assertions");
}
