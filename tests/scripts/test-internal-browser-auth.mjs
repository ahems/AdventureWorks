import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { dabBrowserReadPolicy, functionsBrowserRequest, oauthBrowserRequest } from "./auth-browser-network-policy.mjs";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const result = {
  checks: [], reads: [], transport: [], failedRequests: [], anonymousRequests: [],
  blockedMutations: 0, blockedRequests: [], tokenOriginViolations: 0, phase: "configuration",
};
const policy = JSON.parse(await readFile(new URL("../auth/browser-policy.json", import.meta.url), "utf8"));
const diagnosticLimitMs = policy.startupReadTimeoutMs + 10000;
result.readPolicy = policy;
let browser;
const check = (name, condition) => {
  result.checks.push({ name, status: condition ? "PASS" : "FAIL" });
  assert.ok(condition, name);
};
const endpoint = (name) => {
  const url = new URL(process.env[name]);
  assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash);
  return url;
};
const sites = [
  { name: "admin", url: "APP_ADMIN_URL", path: "/products",
    tokenKey: "dab_oauth_token", generationKey: "dab_oauth_generation",
    userKey: "adventureworks_admin_user", role: "executive-admin" },
  { name: "manufacturing", url: "APP_MANUFACTURING_URL", path: "/define",
    tokenKey: "mfg_dab_oauth_token", generationKey: "mfg_dab_oauth_generation",
    userKey: "adventureworks_manufacturing_user", role: "manufacturing-engineer" },
];

try {
  const mcp = endpoint("API_MCP_URL");
  const dab = endpoint("API_URL");
  const functions = endpoint("API_FUNCTIONS_URL");
  assert.equal(new Set([dab.origin, functions.origin, mcp.origin]).size, 3);
  const allowsDabRead = dabBrowserReadPolicy(
    JSON.parse(await readFile(new URL("../../api/dab-config.json", import.meta.url), "utf8")));
  const allowedTokenOrigins = new Set([dab.origin, functions.origin, mcp.origin]);
  const audience = process.env.DAB_RESOURCE_IDENTIFIER || new URL("/dab", mcp).toString();
  for (const site of sites) {
    site.origin = endpoint(site.url).origin;
    assert.ok(process.env[`AUTH_BROWSER_${site.name.toUpperCase()}_EMAIL`]);
    assert.ok(process.env[`AUTH_BROWSER_${site.name.toUpperCase()}_PASSWORD`]);
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
      let page = await context.newPage();
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
      anonymous = false;
      const signIn = async () => {
        await page.locator("#email").fill(process.env[`AUTH_BROWSER_${site.name.toUpperCase()}_EMAIL`]);
        await page.locator("#password").fill(process.env[`AUTH_BROWSER_${site.name.toUpperCase()}_PASSWORD`]);
        await page.getByRole("button", { name: /^sign in$/i }).click();
        await page.waitForURL((url) => url.origin === site.origin && url.pathname === site.path);
        await page.waitForFunction(({ tokenKey, userKey, generationKey }) => {
          const generation = localStorage.getItem(generationKey);
          return generation && localStorage.getItem(`${tokenKey}:${generation}`) &&
            localStorage.getItem(`${userKey}:${generation}`);
        }, site);
      };
      const signOut = async () => {
        const firstName = await page.evaluate(({ userKey, generationKey }) =>
          JSON.parse(localStorage.getItem(`${userKey}:${localStorage.getItem(generationKey)}`)).firstName, site);
        await page.getByRole("button", { name: new RegExp(firstName) }).first().click();
        await page.getByRole("button", { name: /^sign out$/i }).click();
        await page.waitForURL((url) => url.origin === site.origin && url.pathname === "/login");
      };
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
      const secondPage = await context.newPage();
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
          const origin = new URL(request.url()).origin;
          if (origin === dab.origin || origin === functions.origin) staleTabRequests++;
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
      page = await context.newPage();
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
    category: error.name === "TimeoutError" || /timeout|timed out/i.test(error.message) ? "timeout" :
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
