import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";

const ts = createRequire(new URL("../../app/package.json", import.meta.url))("typescript");

async function loadChat({ claims = { customer_id: "123", business_entity_id: "456" }, chatStatus = 200, answer = "Your orders", refreshStatus = 200 } = {}) {
  const storage = new Map();
  const calls = [];
  const errors = [];
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  storage.set("functions_oauth_token", JSON.stringify({
    accessToken: token, expiresAt: Math.floor(Date.now() / 1000) + 600, scope: "mcp.access orders.read",
  }));
  storage.set("eshop_oauth_refresh_token", "refresh-original");
  const context = vm.createContext({
    URL, URLSearchParams, Date, atob,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: { APP_CONFIG: { API_FUNCTIONS_URL: "https://functions.test" } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/token")) {
        return new Response(JSON.stringify({
          access_token: "mcp-user-token", refresh_token: "refresh-rotated", expires_in: 600,
        }), { status: refreshStatus });
      }
      return new Response(JSON.stringify({ response: answer, threadId: "resp-next", toolsUsed: ["get_customer_orders"] }), { status: chatStatus });
    },
  });
  const modules = new Map();
  async function moduleFor(name) {
    if (modules.has(name)) return modules.get(name);
    if (name === "@/lib/utils" || name === "@/lib/appInsights") {
      const exports = name.endsWith("utils")
        ? { getApiMcpUrl: () => "https://mcp.test/mcp" }
        : { trackError: (...args) => errors.push(args) };
      const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
      modules.set(name, module);
      return module;
    }
    assert.ok(["@/lib/mcpService", "@/services/eshopOAuth", "@/services/functionsAuth"].includes(name));
    const path = new URL(`../../app/src/${name.slice(2)}.ts`, import.meta.url);
    const source = ts.transpileModule(await readFile(path, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: name });
    modules.set(name, module);
    await module.link(moduleFor);
    return module;
  }
  const chat = await moduleFor("@/lib/mcpService");
  await chat.evaluate();
  return { chat: chat.namespace, oauth: modules.get("@/services/eshopOAuth").namespace, storage, calls, errors };
}

test("chat mints an MCP audience token and uses CustomerID, not PersonID", async () => {
  const { chat, storage, calls } = await loadChat();
  const result = await chat.chatWithAgent("Show my orders", [], 456, "Alex", "en", "resp-before");
  assert.equal(result.threadId, "resp-next");
  const grant = new URLSearchParams(calls[0].options.body);
  assert.equal(grant.get("grant_type"), "refresh_token");
  assert.equal(grant.get("resource"), "https://mcp.test/mcp");
  assert.equal(grant.get("refresh_token"), "refresh-original");
  assert.equal(calls[1].options.headers.Authorization, "Bearer mcp-user-token");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.customerId, 123);
  assert.equal(body.threadId, "resp-before");
  assert.equal(storage.get("eshop_oauth_refresh_token"), "refresh-rotated");
  await chat.chatWithAgent("And shipping?", [], 456);
  assert.equal(calls.filter((call) => call.url.endsWith("/token")).length, 1);
});

test("expired MCP tokens refresh and logout clears all resource tokens", async () => {
  const { chat, storage, calls, oauth } = await loadChat();
  storage.set("mcp_oauth_token", JSON.stringify({ accessToken: "expired", expiresAt: 1, scope: "" }));
  await chat.chatWithAgent("Show my orders", [], 456);
  assert.equal(calls[1].options.headers.Authorization, "Bearer mcp-user-token");
  oauth.clearEshopOAuthSession();
  assert.equal(storage.size, 0);
});

test("chat refuses absent or mismatched customer identity before contacting the agent", async () => {
  for (const claims of [{}, { customer_id: "0", business_entity_id: "456" }, { customer_id: "123", business_entity_id: "999" }]) {
    const { chat, calls, errors } = await loadChat({ claims });
    await assert.rejects(chat.chatWithAgent("Show my orders", [], 456), /customer session/);
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 1);
  }
});

test("missing secure session never falls back to backend service authorization", async () => {
  const { chat, storage, calls, errors } = await loadChat();
  storage.delete("eshop_oauth_refresh_token");
  await assert.rejects(chat.chatWithAgent("Show my orders", [], 456), /sign in again/);
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
});

test("failed token refresh clears the session and never sends chat", async () => {
  const { chat, storage, calls } = await loadChat({ refreshStatus: 401 });
  await assert.rejects(chat.chatWithAgent("Show my orders", [], 456), /Sign-in failed/);
  assert.equal(calls.length, 1);
  assert.equal(storage.size, 0);
});

test("HTTP failures and empty AI replies are logged and rejected", async () => {
  for (const options of [{ chatStatus: 500 }, { answer: "" }]) {
    const { chat, errors } = await loadChat(options);
    await assert.rejects(chat.chatWithAgent("Show my orders", [], 456), /HTTP 500|empty response/);
    assert.equal(errors.length, 1);
  }
});
