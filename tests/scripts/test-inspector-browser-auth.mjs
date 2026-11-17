import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const result = { checks: [], proxyResponses: [], browserErrors: [], blockedRequests: [],
  blockedMutations: 0, phase: "configuration" };
let browser;
const check = (name, condition) => {
  result.checks.push({ name, status: condition ? "PASS" : "FAIL" });
  assert.ok(condition, name);
};
try {
  const inspector = new URL(process.env.MCP_INSPECTOR_URL);
  const mcp = new URL(process.env.API_MCP_URL);
  const dab = new URL("/mcp", process.env.API_URL);
  const policy = JSON.parse(await readFile(new URL("../auth/browser-policy.json", import.meta.url), "utf8"));
  result.policy = policy;
  for (const url of [inspector, mcp, dab])
    assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search);
  assert.ok(process.env.AUTH_BROWSER_MANUFACTURING_EMAIL && process.env.AUTH_BROWSER_MANUFACTURING_PASSWORD);
  assert.ok(process.env.AUTH_BROWSER_ADMIN_EMAIL && process.env.AUTH_BROWSER_ADMIN_PASSWORD);
  result.phase = "browser-prerequisites";
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const additionalContexts = [];
  try {
    const readMethods = new Set(["initialize", "notifications/initialized", "tools/list", "resources/list",
      "resources/templates/list", "prompts/list", "logging/setLevel", "ping", "notifications/cancelled"]);
    const guard = async guardedContext => guardedContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
      const sessionDelete = request.method() === "DELETE" && url.origin === inspector.origin &&
        url.pathname === "/proxy/mcp" && [mcp.href, dab.href].includes(url.searchParams.get("url"));
      if (sessionDelete) return route.continue();
      const oauth = url.origin === mcp.origin && ["/login", "/token"].includes(url.pathname);
      const logout = url.origin === inspector.origin && url.pathname === "/auth/logout";
      let safeRpc = false, rpcMethod = "not-rpc";
      if (url.origin === inspector.origin && url.pathname === "/proxy/mcp") {
        try {
          const rpc = request.postDataJSON();
          rpcMethod = typeof rpc.method === "string" && /^[A-Za-z/]+$/.test(rpc.method) ? rpc.method : "invalid-rpc";
          safeRpc = readMethods.has(rpc.method) || rpc.method === "tools/call" &&
            rpc.params?.name === "read_records" && ["Product", "Employee"].includes(rpc.params?.arguments?.entity) &&
            rpc.params?.arguments?.first === 1;
        } catch { safeRpc = false; }
      }
      if (!oauth && !logout && !safeRpc) {
        result.blockedMutations++;
        result.blockedRequests.push({ method: request.method(), rpcMethod,
          service: url.origin === inspector.origin ? "inspector" : "other", phase: result.phase });
        return route.abort();
      }
      return route.continue();
    });
    await guard(context);
    result.phase = "anonymous";
    const startupStarted = performance.now();
    const anonymous = await context.request.get(inspector.origin + "/proxy/config", { timeout: policy.startupReadTimeoutMs });
    const durationMs = Math.round(performance.now() - startupStarted);
    result.startupRead = { status: anonymous.status(), durationMs, timeoutMs: policy.startupReadTimeoutMs,
      slow: durationMs >= policy.slowReadThresholdMs };
    check("anonymous-proxy-denied", anonymous.status() === 401 && durationMs <= policy.startupReadTimeoutMs);
    const page = await context.newPage();
    page.on("dialog", dialog => { void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()); });
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === inspector.origin && (url.pathname.startsWith("/proxy/") || url.pathname === "/auth/logout") &&
          result.proxyResponses.length < 50)
        result.proxyResponses.push({ endpoint: url.pathname === "/proxy/mcp" ? "mcp" :
          url.pathname === "/proxy/health" ? "health" : url.pathname === "/auth/logout" ? "logout" : "config",
        status: response.status() });
    });
    page.on("console", message => {
      if (message.type() !== "error" || result.browserErrors.length >= 15) return;
      const text = message.text();
      result.browserErrors.push(/Content Security Policy|content security policy|violates.*directive/.test(text) ? "csp" :
        /Failed to fetch|NetworkError/.test(text) ? "network" :
        /Proxy Server/.test(text) ? "proxy" : "client-error");
    });
    page.setDefaultTimeout(90000);
    await page.goto(inspector.origin, { waitUntil: "domcontentloaded" });
    check("anonymous-ui-gated", await page.getByRole("link", { name: "Sign in", exact: true }).isVisible() &&
      await page.locator("iframe").count() === 0);
    result.phase = "pkce-login";
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator('input[name="username"]').fill(process.env.AUTH_BROWSER_MANUFACTURING_EMAIL);
    await page.locator('input[name="password"]').fill(process.env.AUTH_BROWSER_MANUFACTURING_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(url => url.origin === inspector.origin && url.pathname === "/");
    check("internal-pkce-session", await page.getByRole("button", { name: "Sign out", exact: true }).isVisible());
    const cookies = await context.cookies(inspector.origin);
    const session = cookies.find(cookie => cookie.name === "__Host-aw-inspector");
    check("opaque-secure-session", session?.httpOnly && session.secure && session.sameSite === "Lax" &&
      /^[A-Za-z0-9_-]{43}$/.test(session.value));
    check("no-browser-bearer-tokens", await page.evaluate(() =>
      [localStorage, sessionStorage].every(storage => Object.keys(storage).every(key =>
        !/oauth.*token|access.?token|refresh.?token/i.test(key) &&
        !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(storage.getItem(key))))));
    result.phase = "custom-ui-connect";
    const frame = page.frameLocator('iframe[title="MCP Inspector"]');
    const frameSource = new URL(await page.locator('iframe[title="MCP Inspector"]').getAttribute("src"), inspector.origin);
    check("bounded-demo-client-timeout",
      frameSource.searchParams.get("MCP_SERVER_REQUEST_TIMEOUT") === String(policy.startupReadTimeoutMs) &&
      frameSource.searchParams.get("MCP_REQUEST_MAX_TOTAL_TIMEOUT") === String(policy.startupReadTimeoutMs));
    await frame.getByRole("button", { name: /^Connect$/i }).click();
    result.phase = "custom-ui-connected-state";
    await frame.getByRole("button", { name: /^Disconnect$/i }).waitFor({ timeout: policy.startupReadTimeoutMs });
    check("custom-inspector-ui-connected", true);
    await frame.getByRole("button", { name: /^Disconnect$/i }).click();
    await frame.getByRole("button", { name: /^Connect$/i }).waitFor();
    result.phase = "dab-ui-connect";
    await page.getByRole("link", { name: "DAB MCP", exact: true }).click();
    await frame.getByRole("button", { name: /^Connect$/i }).click();
    await frame.getByRole("button", { name: /^Disconnect$/i }).waitFor({ timeout: policy.startupReadTimeoutMs });
    check("dab-inspector-ui-connected", true);
    await frame.getByRole("button", { name: /^Disconnect$/i }).click();
    await frame.getByRole("button", { name: /^Connect$/i }).waitFor();

    const protocol = async (target, entity, sourcePage = page, keepSession = false) => sourcePage.evaluate(async ({ target, entity, keepSession }) => {
      const url = "/proxy/mcp?url=" + encodeURIComponent(target);
      let id = 0, sessionId;
      const call = async (method, params) => {
        const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-03-26",
          "X-MS-API-ROLE": "executive-admin" };
        if (sessionId) headers["Mcp-Session-Id"] = sessionId;
        const response = await fetch(url, { method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++id }),
            method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(90000) });
        sessionId = response.headers.get("mcp-session-id") || sessionId;
        const raw = await response.text();
        let body = null;
        if (raw) body = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ?
          raw.split("\n").find(line => line.startsWith("data:")).slice(5).trim() : raw);
        return { status: response.status, body };
      };
      let initialized, catalog, read, cleaned;
      try {
        initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "inspector-auth-assurance", version: "1.0" } });
        if (initialized.status !== 200 || !initialized.body?.result) return { initialized: false };
        await call("notifications/initialized");
        catalog = await call("tools/list");
        if (entity) {
          const response = await call("tools/call", { name: "read_records", arguments: {
            entity, select: entity === "Product" ? "ProductID" : "BusinessEntityID", first: 1,
          } });
          const tool = response.body?.result;
          const content = tool?.content?.find(value => value.type === "text");
          const payload = content ? JSON.parse(content.text) : null;
          read = { allowed: response.status === 200 && !tool?.isError && payload?.status === "success" &&
            Array.isArray(payload?.result?.value) && payload.result.value.length === 1,
          denied: response.status === 200 && tool?.isError === true &&
            payload?.error?.type === "PermissionDenied" };
        }
      } finally {
        if (sessionId && !keepSession) {
          const response = await fetch(url, { method: "DELETE", headers: {
            "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-03-26",
          }, signal: AbortSignal.timeout(30000) });
          cleaned = [200, 202, 204, 405].includes(response.status);
        } else cleaned = !sessionId;
      }
      return { initialized: initialized?.status === 200, catalog: catalog?.status === 200 &&
        Array.isArray(catalog.body?.result?.tools) && catalog.body.result.tools.length > 0, read, cleaned,
        ...(keepSession ? { sessionId } : {}) };
    }, { target, entity, keepSession });

    result.phase = "target-authorization";
    const custom = await protocol(mcp.href);
    check("custom-delegated-catalog", custom.initialized && custom.catalog && custom.cleaned);
    const allowed = await protocol(dab.href, "Product");
    check("dab-delegated-product-read", allowed.initialized && allowed.catalog && allowed.read?.allowed && allowed.cleaned);
    const denied = await protocol(dab.href, "Employee");
    check("manufacturing-role-escalation-denied", denied.read?.denied && denied.cleaned);
    check("arbitrary-target-denied", (await context.request.get(inspector.origin +
      "/proxy/mcp?url=https%3A%2F%2Fexample.invalid%2Fmcp")).status() === 403);
    check("stdio-disabled", (await context.request.get(inspector.origin + "/proxy/stdio?command=node")).status() === 404);
    check("untrusted-origin-denied", (await context.request.post(inspector.origin + "/proxy/mcp?url=" +
      encodeURIComponent(mcp.href), { headers: { Origin: "https://example.invalid" }, data: {} })).status() === 403);
    result.phase = "multi-tab-session";
    const secondTab = await context.newPage();
    secondTab.setDefaultTimeout(90000);
    await secondTab.goto(inspector.origin, { waitUntil: "domcontentloaded" });
    check("same-context-second-tab-authenticated",
      await secondTab.getByRole("button", { name: "Sign out", exact: true }).isVisible() &&
      (await context.request.get(inspector.origin + "/proxy/config")).status() === 200);
    const tabDenied = await protocol(dab.href, "Employee", secondTab);
    check("second-tab-manufacturing-role-preserved", tabDenied.read?.denied && tabDenied.cleaned);

    result.phase = "independent-admin-login";
    const adminContext = await browser.newContext();
    additionalContexts.push(adminContext);
    await guard(adminContext);
    check("independent-context-anonymous", (await adminContext.request.get(inspector.origin + "/proxy/config")).status() === 401);
    const adminPage = await adminContext.newPage();
    adminPage.setDefaultTimeout(90000);
    await adminPage.goto(inspector.origin, { waitUntil: "domcontentloaded" });
    await adminPage.getByRole("link", { name: "Sign in", exact: true }).click();
    await adminPage.locator('input[name="username"]').fill(process.env.AUTH_BROWSER_ADMIN_EMAIL);
    await adminPage.locator('input[name="password"]').fill(process.env.AUTH_BROWSER_ADMIN_PASSWORD);
    await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await adminPage.waitForURL(url => url.origin === inspector.origin && url.pathname === "/");
    const adminSession = (await adminContext.cookies(inspector.origin)).find(cookie => cookie.name === "__Host-aw-inspector");
    check("independent-admin-session", await adminPage.getByRole("button", { name: "Sign out", exact: true }).isVisible() &&
      adminSession?.httpOnly && adminSession.secure && adminSession.sameSite === "Lax" &&
      /^[A-Za-z0-9_-]{43}$/.test(adminSession.value) && adminSession.value !== session.value);
    const adminAllowed = await protocol(dab.href, "Employee", adminPage);
    check("admin-delegated-employee-read", adminAllowed.initialized && adminAllowed.catalog &&
      adminAllowed.read?.allowed && adminAllowed.cleaned);
    const stillDenied = await protocol(dab.href, "Employee", secondTab);
    check("admin-login-does-not-elevate-manufacturing", stillDenied.read?.denied && stillDenied.cleaned);
    result.phase = "backend-session-isolation";
    const ownedBackend = await protocol(dab.href, undefined, secondTab, true);
    check("owned-backend-session-established", ownedBackend.initialized && ownedBackend.catalog &&
      typeof ownedBackend.sessionId === "string" && ownedBackend.sessionId.length > 0);
    try {
      for (const [name, callerContext, target] of [
        ["other-user-backend-session-denied", adminContext, dab.href],
        ["other-target-backend-session-denied", context, mcp.href],
      ]) {
        const replay = await callerContext.request.post(inspector.origin + "/proxy/mcp?url=" + encodeURIComponent(target), {
          headers: { Origin: inspector.origin, "Mcp-Session-Id": ownedBackend.sessionId,
            "MCP-Protocol-Version": "2025-03-26" },
          data: { jsonrpc: "2.0", id: 1, method: "tools/list" }, timeout: 90000,
        });
        const denial = await replay.json();
        check(name, replay.status() === 403 && denial.error === "session_not_owned");
      }
      const ownerRead = await context.request.post(inspector.origin + "/proxy/mcp?url=" + encodeURIComponent(dab.href), {
        headers: { Origin: inspector.origin, "Mcp-Session-Id": ownedBackend.sessionId,
          "MCP-Protocol-Version": "2025-03-26" },
        data: { jsonrpc: "2.0", id: 2, method: "tools/list" }, timeout: 90000,
      });
      const raw = await ownerRead.text();
      const ownerResult = JSON.parse(ownerRead.headers()["content-type"]?.includes("text/event-stream") ?
        raw.split("\n").find(line => line.startsWith("data:")).slice(5).trim() : raw);
      check("owner-backend-session-survives-replay", ownerRead.status() === 200 &&
        Array.isArray(ownerResult.result?.tools) && ownerResult.result.tools.length > 0);
    } finally {
      const cleanup = await context.request.delete(inspector.origin + "/proxy/mcp?url=" + encodeURIComponent(dab.href), {
        headers: { Origin: inspector.origin, "Mcp-Session-Id": ownedBackend.sessionId,
          "MCP-Protocol-Version": "2025-03-26" }, timeout: 30000,
      });
      check("owned-backend-session-cleanup", [200, 202, 204, 405].includes(cleanup.status()));
    }

    result.phase = "logout";
    const oldSessionCookie = session.name + "=" + session.value;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
    check("logout-invalidates-session", (await context.request.get(inspector.origin + "/proxy/config", {
      headers: { Cookie: oldSessionCookie },
    })).status() === 401);
    const tabStatus = await secondTab.evaluate(async () => (await fetch("/proxy/config")).status);
    await secondTab.reload({ waitUntil: "domcontentloaded" });
    check("logout-invalidates-other-tab", tabStatus === 401 &&
      await secondTab.getByRole("link", { name: "Sign in", exact: true }).isVisible());
    const independentRead = await protocol(dab.href, "Employee", adminPage);
    check("manufacturing-logout-preserves-admin", independentRead.read?.allowed && independentRead.cleaned &&
      (await adminContext.request.get(inspector.origin + "/proxy/config")).status() === 200);
    const adminCookie = adminSession.name + "=" + adminSession.value;
    const adminLogout = await adminContext.request.post(inspector.origin + "/auth/logout", {
      headers: { Origin: inspector.origin }, maxRedirects: 0,
    });
    check("admin-logout-invalidates-only-own-session", adminLogout.status() === 303 &&
      (await adminContext.request.get(inspector.origin + "/proxy/config", { headers: { Cookie: adminCookie } })).status() === 401 &&
      (await context.request.get(inspector.origin + "/proxy/config", { headers: { Cookie: oldSessionCookie } })).status() === 401);
    check("no-business-mutations", result.blockedMutations === 0);
    result.phase = "complete";
  } finally {
    try {
      const cleanups = await Promise.allSettled([context, ...additionalContexts].map(async ownedContext => {
        try {
          const cleanup = await ownedContext.request.post(inspector.origin + "/auth/logout", {
            headers: { Origin: inspector.origin }, timeout: 30000, maxRedirects: 0,
          });
          assert.equal(cleanup.status(), 303, "Inspector session cleanup");
        } finally { await ownedContext.close(); }
      }));
      assert.ok(cleanups.every(cleanup => cleanup.status === "fulfilled"), "All Inspector sessions cleaned up");
    } finally { await context.close(); }
  }
} catch (error) {
  result.error = { name: ["TimeoutError", "AssertionError", "Error", "TypeError"].includes(error.name) ? error.name : "BrowserError" };
  result.checks.push({ name: result.phase, status: result.phase === "browser-prerequisites" ? "BLOCKED" : "FAIL" });
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  }
  console.log("Inspector browser auth: " + result.phase + "; " + result.checks.length + " sanitized assertions");
}
