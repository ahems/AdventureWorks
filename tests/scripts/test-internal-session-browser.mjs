import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

const appRequire = createRequire(new URL("../../app/package.json", import.meta.url));
const mfgRequire = createRequire(new URL("../../app-manufacturing/package.json", import.meta.url));
const { chromium } = appRequire("playwright");
const ts = mfgRequire("typescript");
const modules = new Map();
let browser, server, origin, pendingRequest;

before(async () => {
  for (const app of ["app-admin", "app-manufacturing"]) {
    const source = await readFile(new URL(`../../${app}/src/services/dabAuth.ts`, import.meta.url), "utf8");
    const importLine = app === "app-admin"
      ? 'import { getApiMcpUrl } from "@/lib/utils";'
      : 'import { API_MCP_URL } from "@/config/api";';
    const config = app === "app-admin"
      ? 'const getApiMcpUrl = () => `${window.location.origin}/mcp`;'
      : 'const API_MCP_URL = `${window.location.origin}/mcp`;';
    assert.ok(source.includes(importLine), `Expected config import in ${app}`);
    modules.set(`/${app}.js`, ts.transpileModule(source.replace(importLine, config), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
  server = createServer((request, response) => {
    const path = new URL(request.url, origin).pathname;
    if (modules.has(path)) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(modules.get(path));
    } else if (path === "/token" && request.method === "POST") {
      if (!pendingRequest) {
        response.writeHead(500).end();
        return;
      }
      pendingRequest(response);
      pendingRequest = undefined;
      request.resume();
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Session test</title>");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

for (const app of ["app-admin", "app-manufacturing"]) {
  const transitions = [
    { kind: "callback", status: 200 },
    { kind: "refresh", status: 200 }, { kind: "refresh", status: 400 },
    { kind: "functions", status: 200 }, { kind: "functions", status: 401 },
    ...(app === "app-admin" ? [{ kind: "mcp", status: 200 }, { kind: "mcp", status: 401 }] : []),
  ];
  for (const { kind, status } of transitions) {
    test(`${app}: real browser rejects a stale ${kind} ${status} after cross-tab logout and switch`,
      { timeout: 15000 }, async () => {
        const context = await browser.newContext();
        try {
          const first = await context.newPage();
          const second = await context.newPage();
          await first.goto(`${origin}/oauth/callback?code=code&state=state`);
          await second.goto(`${origin}/`);
          for (const page of [first, second]) {
            await page.evaluate(async path => { window.auth = await import(path); }, `/${app}.js`);
          }
          const prefix = app === "app-manufacturing" ? "mfg_" : "";
          const generationKey = `${prefix}dab_oauth_generation`;
          const tokenKey = `${prefix}dab_oauth_token`;
          const pkceKey = `${prefix}dab_oauth_pkce`;
          const record = accessToken => JSON.stringify({
            accessToken, refreshToken: `refresh-${accessToken}`,
            expiresAt: Math.floor(Date.now() / 1000) + 600, scope: "",
          });
          await first.evaluate(({ generationKey, tokenKey, pkceKey, oldToken }) => {
            localStorage.setItem(generationKey, "old");
            localStorage.setItem(`${tokenKey}:old`, oldToken);
            sessionStorage.setItem(pkceKey, JSON.stringify({
              verifier: "verifier", state: "state", generation: "old",
            }));
          }, { generationKey, tokenKey, pkceKey, oldToken: record("old") });
          const request = new Promise(resolve => { pendingRequest = resolve; });
          const result = first.evaluate(transition => {
            if (transition === "callback") return window.auth.handleCallback();
            if (transition === "refresh") return window.auth.refreshAccessToken(true);
            if (transition === "mcp") return window.auth.getMcpAccessToken(true);
            return window.auth.getFunctionsAccessToken(true);
          }, kind);
          const response = await request;
          await second.evaluate(async ({ generationKey, tokenKey, newToken }) => {
            window.auth.clearAuthorization();
            const submit = HTMLFormElement.prototype.submit;
            HTMLFormElement.prototype.submit = () => {};
            try {
              await window.auth.startSilentSignIn("test-user", "test-password");
            } finally {
              HTMLFormElement.prototype.submit = submit;
            }
            const generation = localStorage.getItem(generationKey);
            localStorage.setItem(`${tokenKey}:${generation}`, newToken);
          }, { generationKey, tokenKey, newToken: record("new") });
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ access_token: "stale", refresh_token: "stale-refresh", expires_in: 600 }));
          const oldResult = await result;
          assert.equal(kind === "callback" ? oldResult.ok : oldResult, kind === "callback" ? false : null);
          assert.equal(await second.evaluate(() => window.auth.getAccessToken()), "new");
          assert.equal(await first.evaluate(() => window.auth.getAccessToken()), null);
          await first.reload();
          await first.evaluate(async path => { window.auth = await import(path); }, `/${app}.js`);
          assert.equal(await first.evaluate(() => window.auth.getAccessToken()), null);
        } finally {
          await context.close();
        }
      });
  }
}
