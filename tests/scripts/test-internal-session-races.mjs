import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app-manufacturing/package.json", import.meta.url));
const ts = require("typescript");

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function loadOAuth(app, fetch, crypto = webcrypto, shared = {}) {
  const localStorage = shared.localStorage ?? storage();
  const sessionStorage = shared.sessionStorage ?? storage();
  const window = new EventTarget();
  window.location = {
    href: "https://portal.example.test/oauth/callback?code=code&state=state",
    origin: "https://portal.example.test",
    assign() {},
  };
  window.history = { replaceState() {} };
  let lost = 0;
  window.addEventListener("dab-session-lost", () => lost++);
  const context = vm.createContext({
    window, localStorage, sessionStorage, navigator: {}, Event, DOMException, URL, URLSearchParams,
    crypto, TextEncoder, btoa, atob, fetch,
  });
  const source = await readFile(new URL(`../../${app}/src/services/dabAuth.ts`, import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  const config = new vm.SyntheticModule(["getApiMcpUrl", "API_MCP_URL"], function () {
    this.setExport("getApiMcpUrl", () => "https://oauth.example.test/mcp");
    this.setExport("API_MCP_URL", "https://oauth.example.test/mcp");
  }, { context });
  await module.link(() => config);
  await module.evaluate();
  const prefix = app === "app-manufacturing" ? "mfg_" : "";
  return {
    oauth: module.namespace, oauthModule: module, context, window, localStorage, sessionStorage,
    generationKey: `${prefix}dab_oauth_generation`,
    tokenKey: `${prefix}dab_oauth_token`,
    pkceKey: `${prefix}dab_oauth_pkce`,
    get lost() { return lost; },
  };
}

async function mountAuthContext(app, env, { callback = false, chat = false } = {}) {
  const React = require("react");
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://portal.example.test/" });
  const previous = { window: globalThis.window, document: globalThis.document,
    navigator: globalThis.navigator, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const { QueryClient, QueryClientProvider, useQueryClient } = require("@tanstack/react-query");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { act } = React;
  const source = await readFile(new URL(`../../${app}/src/context/AuthContext.tsx`, import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText, { context: env.context });
  const reactModule = new vm.SyntheticModule([...Object.keys(React), "default"], function () {
    for (const [key, value] of Object.entries(React)) this.setExport(key, value);
    this.setExport("default", React);
  }, { context: env.context });
  const toastModule = new vm.SyntheticModule(["toast"], function () {
    this.setExport("toast", () => {});
  }, { context: env.context });
  const queryModule = new vm.SyntheticModule(["useQueryClient"], function () {
    this.setExport("useQueryClient", useQueryClient);
  }, { context: env.context });
  await module.link(specifier => {
    if (specifier === "react") return reactModule;
    if (specifier === "@tanstack/react-query") return queryModule;
    if (specifier === "@/hooks/use-toast") return toastModule;
    if (specifier === "@/services/dabAuth") return env.oauthModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  let current;
  let navigationCount = 0;
  function Probe() {
    current = module.namespace.useAuth();
    return null;
  }
  let callbackElement = null;
  if (callback) {
    const callbackSource = await readFile(new URL(`../../${app}/src/pages/OAuthCallbackPage.tsx`, import.meta.url), "utf8");
    const callbackModule = new vm.SourceTextModule(ts.transpileModule(callbackSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
    }).outputText, { context: env.context });
    const router = new vm.SyntheticModule(["useNavigate"], function () {
      this.setExport("useNavigate", () => () => { navigationCount++; });
    }, { context: env.context });
    const icons = new vm.SyntheticModule(["Loader2", "ShieldCheck", "ShieldAlert"], function () {
      for (const name of ["Loader2", "ShieldCheck", "ShieldAlert"]) this.setExport(name, () => null);
    }, { context: env.context });
    await callbackModule.link(specifier => {
      if (specifier === "react") return reactModule;
      if (specifier === "react-router-dom") return router;
      if (specifier === "lucide-react") return icons;
      if (specifier === "@/services/dabAuth") return env.oauthModule;
      if (specifier === "@/context/AuthContext") return module;
      throw new Error(`Unexpected callback import: ${specifier}`);
    });
    await callbackModule.evaluate();
    callbackElement = React.createElement(callbackModule.namespace.default);
  }
  let chatElement = null;
  if (chat) {
    const chatSource = await readFile(new URL("../../app-admin/src/components/AiAgentChat.tsx", import.meta.url), "utf8");
    const chatModule = new vm.SourceTextModule(ts.transpileModule(chatSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
    }).outputText, { context: env.context });
    const names = ["Bot", "Send", "User", "Loader2", "Terminal", "ChevronDown", "ChevronUp",
      "Sparkles", "Trash2", "Plus", "MessageSquare", "X", "Search", "Lightbulb"];
    const icons = new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, () => null);
    }, { context: env.context });
    const ui = new vm.SyntheticModule(["Button", "Input", "ScrollArea"], function () {
      const element = React.forwardRef((props, ref) => React.createElement("div", { ref }, props.children));
      for (const name of ["Button", "Input", "ScrollArea"]) this.setExport(name, element);
    }, { context: env.context });
    const agent = new vm.SyntheticModule(["sendAgentMessage", "getAgentStatus"], function () {
      this.setExport("sendAgentMessage", async () => { throw new Error("Unexpected agent call"); });
      this.setExport("getAgentStatus", async () => ({ features: [] }));
    }, { context: env.context });
    await chatModule.link(specifier => {
      if (specifier === "react") return reactModule;
      if (specifier === "lucide-react") return icons;
      if (specifier.startsWith("@/components/ui/")) return ui;
      if (specifier === "@/services/agentService") return agent;
      if (specifier === "@/services/dabAuth") return env.oauthModule;
      throw new Error(`Unexpected chat import: ${specifier}`);
    });
    await chatModule.evaluate();
    chatElement = React.createElement(chatModule.namespace.default);
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(module.namespace.AuthProvider, null, React.createElement(Probe), callbackElement, chatElement))));
  return {
    get current() { return current; },
    get navigationCount() { return navigationCount; },
    get text() { return dom.window.document.body.textContent; },
    queryClient,
    act,
    async close() {
      await act(async () => root.unmount());
      queryClient.clear();
      dom.window.close();
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      Object.defineProperty(globalThis, "navigator", { value: previous.navigator, configurable: true });
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

function token(accessToken) {
  return JSON.stringify({
    accessToken, refreshToken: `refresh-${accessToken}`,
    expiresAt: Math.floor(Date.now() / 1000) + 600, scope: "",
  });
}

function response(status, accessToken = "old-result") {
  return {
    ok: status === 200, status,
    text: async () => "rejected",
    json: async () => ({ access_token: accessToken, refresh_token: "rotated", expires_in: 600 }),
  };
}

async function tokenFromNewTab(app, env) {
  const tab = await loadOAuth(app, async () => response(200), webcrypto, {
    localStorage: env.localStorage,
  });
  return tab.oauth.getAccessToken();
}

function stubLoginForm(env) {
  env.context.document = {
    createElement: tag => tag === "form" ? { style: {}, appendChild() {}, submit() {} } : {},
    body: { appendChild() {} },
  };
}

test("admin chat restores only the current session's conversations, never unscoped or previous-session history", async () => {
  const shared = storage();
  const first = await loadOAuth("app-admin", async () => response(200), webcrypto, { localStorage: shared });
  const userKey = "adventureworks_admin_user";
  const conversations = message => JSON.stringify({
    activeId: "chat", conversations: [{ id: "chat", title: "Chat",
      messages: [{ role: "user", content: message }], createdAt: 1 }],
  });
  shared.setItem(first.generationKey, "old");
  shared.setItem(`${first.tokenKey}:old`, token("old"));
  shared.setItem(`${userKey}:old`, JSON.stringify({ id: "emp_old", firstName: "Old" }));
  shared.setItem("ai-agent-conversations", conversations("Unscoped private history"));
  shared.setItem("ai-agent-conversations:session:old", conversations("Old private history"));
  const oldChat = await mountAuthContext("app-admin", first, { chat: true });
  try {
    assert.match(oldChat.text, /Old private history/);
    assert.doesNotMatch(oldChat.text, /Unscoped private history/);
  } finally {
    await oldChat.close();
  }
  shared.setItem(first.generationKey, "new");
  shared.setItem(`${first.tokenKey}:new`, token("new"));
  shared.setItem(`${userKey}:new`, JSON.stringify({ id: "emp_new", firstName: "New" }));
  const second = await loadOAuth("app-admin", async () => response(200), webcrypto, { localStorage: shared });
  const newChat = await mountAuthContext("app-admin", second, { chat: true });
  try {
    assert.doesNotMatch(newChat.text, /Old private history|Unscoped private history/);
    assert.doesNotMatch(shared.getItem("ai-agent-conversations:session:new"), /Old private history|Unscoped private history/);
    assert.match(shared.getItem("ai-agent-conversations"), /Unscoped private history/);
  } finally {
    await newChat.close();
  }
});

for (const app of ["app-admin", "app-manufacturing"]) {
  test(`${app}: logout removes cached data and prevents an in-flight read from repopulating it`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    env.localStorage.setItem(`${userKey}:old`, JSON.stringify({ id: "emp_old", firstName: "Old" }));
    const mounted = await mountAuthContext(app, env);
    try {
      mounted.queryClient.setQueryData(["private"], "old user data");
      const pending = deferred();
      const read = mounted.queryClient.fetchQuery({ queryKey: ["in-flight"], queryFn: () => pending.promise }).catch(() => null);
      await mounted.act(async () => mounted.current.logout());
      assert.equal(mounted.queryClient.getQueryData(["private"]), undefined);
      pending.resolve("old user data");
      await read;
      assert.equal(mounted.queryClient.getQueryData(["in-flight"]), undefined);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: cross-tab session loss clears private cache but unrelated storage changes do not`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    env.localStorage.setItem(`${userKey}:old`, JSON.stringify({ id: "emp_old", firstName: "Old" }));
    const mounted = await mountAuthContext(app, env);
    try {
      mounted.queryClient.setQueryData(["private"], "old user data");
      await mounted.act(async () => env.window.dispatchEvent(new Event("storage")));
      assert.equal(mounted.queryClient.getQueryData(["private"]), "old user data");
      env.localStorage.setItem(env.generationKey, "new");
      await mounted.act(async () => env.window.dispatchEvent(new Event("storage")));
      assert.equal(mounted.current.user, null);
      assert.equal(mounted.queryClient.getQueryData(["private"]), undefined);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: a stale logout callback cannot clear the new same-tab session or cache`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    const jwt = `e30.${Buffer.from(JSON.stringify({ sub: "new", name: "New User" })).toString("base64url")}.sig`;
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    env.localStorage.setItem(`${userKey}:old`, JSON.stringify({ id: "emp_old", firstName: "Old" }));
    const mounted = await mountAuthContext(app, env);
    try {
      const staleLogout = mounted.current.logout;
      stubLoginForm(env);
      await env.oauth.startSilentSignIn("new-user", "password");
      const generation = env.oauth.getAuthorizationGeneration();
      env.localStorage.setItem(`${env.tokenKey}:${generation}`, token(jwt));
      mounted.queryClient.setQueryData(["private"], "old user data");
      await mounted.act(async () => assert.equal(mounted.current.completeSignIn(generation), true));
      assert.equal(mounted.queryClient.getQueryData(["private"]), undefined);
      mounted.queryClient.setQueryData(["private"], "new user data");
      await mounted.act(async () => staleLogout());
      assert.equal(mounted.current.user.id, "emp_new");
      assert.equal(env.oauth.getAccessToken(), jwt);
      assert.equal(mounted.queryClient.getQueryData(["private"]), "new user data");
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: an old tab and its reload cannot use a different tab's new session`, async () => {
    const sharedLocal = storage();
    const oldTabStorage = storage();
    let requests = 0;
    const fetch = async () => { requests++; return response(200); };
    const oldTab = await loadOAuth(app, fetch, webcrypto, {
      localStorage: sharedLocal, sessionStorage: oldTabStorage,
    });
    const newTab = await loadOAuth(app, fetch, webcrypto, { localStorage: sharedLocal });
    sharedLocal.setItem(oldTab.generationKey, "old");
    sharedLocal.setItem(`${oldTab.tokenKey}:old`, token("old"));
    assert.equal(oldTab.oauth.getAccessToken(), "old");
    sharedLocal.setItem(oldTab.generationKey, "new");
    sharedLocal.setItem(`${oldTab.tokenKey}:new`, token("new"));
    assert.equal(oldTab.oauth.getAccessToken(), null);
    assert.equal(await oldTab.oauth.refreshAccessToken(true), null);
    assert.equal(await oldTab.oauth.getFunctionsAccessToken(true), null);
    assert.equal(requests, 0);
    assert.equal(newTab.oauth.getAccessToken(), "new");
    const reloaded = await loadOAuth(app, fetch, webcrypto, {
      localStorage: sharedLocal, sessionStorage: oldTabStorage,
    });
    assert.equal(reloaded.oauth.getAccessToken(), null);
  });

  test(`${app}: logout during callback cannot restore a session`, async () => {
    const pending = deferred();
    const env = await loadOAuth(app, () => pending.promise);
    env.localStorage.setItem(env.generationKey, "old");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "old",
    }));
    const callback = env.oauth.handleCallback();
    env.oauth.clearAuthorization();
    pending.resolve(response(200));
    assert.equal((await callback).ok, false);
    assert.equal(env.oauth.hasSession(), false);
    assert.equal(env.localStorage.getItem(`${env.tokenKey}:old`), null);
  });

  test(`${app}: logout frees token space before retrying a quota-blocked revocation`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    env.localStorage.setItem(env.tokenKey, token("legacy"));
    const setItem = env.localStorage.setItem;
    let quotaFailure = true;
    env.localStorage.setItem = (key, value) => {
      if (key === `${env.generationKey}:revoked:legacy` && quotaFailure) {
        quotaFailure = false;
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      setItem(key, value);
    };
    env.oauth.clearAuthorization();
    assert.equal(env.oauth.hasSession(), false);
    assert.equal(env.localStorage.getItem(env.tokenKey), null);
    assert.equal(env.localStorage.getItem(`${env.generationKey}:revoked:legacy`), "1");
  });

  test(`${app}: normal callback creates a scoped user and logout clears it`, async () => {
    const jwt = `e30.${Buffer.from(JSON.stringify({ sub: "42", name: "Example User" })).toString("base64url")}.sig`;
    const env = await loadOAuth(app, async () => response(200, jwt));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    env.localStorage.setItem(env.generationKey, "current");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "current",
    }));
    const mounted = await mountAuthContext(app, env);
    try {
      assert.equal((await env.oauth.handleCallback()).ok, true);
      await mounted.act(async () => assert.equal(mounted.current.completeSignIn("current"), true));
      assert.equal(mounted.current.user.id, "emp_42");
      assert.equal(mounted.current.isAuthenticated, true);
      assert.equal(JSON.parse(env.localStorage.getItem(`${userKey}:current`)).id, "emp_42");
      await mounted.act(async () => mounted.current.logout());
      assert.equal(mounted.current.isAuthenticated, false);
      assert.equal(env.oauth.hasSession(), false);
      assert.equal(env.localStorage.getItem(`${userKey}:current`), null);
      assert.equal(env.localStorage.getItem(`${env.tokenKey}:current`), null);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: the callback page completes a correctly bound sign-in`, async () => {
    const jwt = `e30.${Buffer.from(JSON.stringify({ sub: "42", name: "Example User" })).toString("base64url")}.sig`;
    const env = await loadOAuth(app, async () => response(200, jwt));
    env.localStorage.setItem(env.generationKey, "current");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "current",
    }));
    const mounted = await mountAuthContext(app, env, { callback: true });
    try {
      assert.equal(mounted.current.user.id, "emp_42");
      assert.equal(mounted.current.isAuthenticated, true);
      assert.equal(mounted.navigationCount, 1);
      assert.equal(env.sessionStorage.getItem(env.pkceKey), null);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: pre-existing unscoped sessions remain usable until logout`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    env.localStorage.setItem(env.tokenKey, token("legacy"));
    env.localStorage.setItem(userKey, JSON.stringify({ id: "emp_legacy", firstName: "Legacy" }));
    const mounted = await mountAuthContext(app, env);
    try {
      assert.equal(mounted.current.isAuthenticated, true);
      assert.equal(env.oauth.getAccessToken(), "legacy");
      await mounted.act(async () => mounted.current.logout());
      assert.equal(env.oauth.hasSession(), false);
      assert.equal(env.localStorage.getItem(env.tokenKey), null);
      assert.equal(env.localStorage.getItem(userKey), null);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: an old callback cannot consume a newer generation`, async () => {
    let calls = 0;
    const env = await loadOAuth(app, async () => { calls++; return response(200); });
    env.localStorage.setItem(env.generationKey, "new");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "old",
    }));
    assert.equal((await env.oauth.handleCallback()).ok, false);
    assert.equal(calls, 0);
    assert.equal(env.oauth.hasSession(), false);
  });

  for (const scenario of ["old-code", "old-error", "missing-state", "state-mismatch", "malformed-state"]) {
    test(`${app}: ${scenario} callback page cannot clear a newer session`, async () => {
      let requests = 0;
      const env = await loadOAuth(app, async () => { requests++; return response(200); });
      const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
      env.localStorage.setItem(env.generationKey, "new");
      env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      env.localStorage.setItem(`${userKey}:new`, JSON.stringify({ id: "emp_new", firstName: "New" }));
      if (scenario === "malformed-state") {
        env.sessionStorage.setItem(env.pkceKey, "{");
      } else if (scenario !== "missing-state") {
        env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
          verifier: "verifier", state: scenario === "state-mismatch" ? "wrong" : "state",
          generation: scenario === "state-mismatch" ? "new" : "old",
        }));
      }
      if (scenario === "old-error") {
        env.window.location.href = "https://portal.example.test/oauth/callback?error=access_denied&state=state";
      }
      const mounted = await mountAuthContext(app, env, { callback: true });
      try {
        const boundToNew = scenario === "missing-state" || scenario === "state-mismatch";
        assert.equal(env.oauth.getAccessToken(), boundToNew ? "new" : null);
        assert.equal(mounted.current.user?.id ?? null, boundToNew ? "emp_new" : null);
        assert.equal(JSON.parse(env.localStorage.getItem(`${userKey}:new`)).id, "emp_new");
        assert.equal(mounted.navigationCount, 0);
        assert.match(mounted.text, /Sign-in was superseded|Missing or invalid sign-in state/);
        assert.equal(requests, 0);
      } finally {
        await mounted.close();
      }
    });
  }

  test(`${app}: a callback superseded during exchange stops loading without clearing the new session`, async () => {
    const pending = deferred();
    const started = deferred();
    const env = await loadOAuth(app, () => { started.resolve(); return pending.promise; });
    env.localStorage.setItem(env.generationKey, "old");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "old",
    }));
    const mounted = await mountAuthContext(app, env, { callback: true });
    try {
      await started.promise;
      env.oauth.clearAuthorization();
      env.localStorage.setItem(env.generationKey, "new");
      env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      await mounted.act(async () => {
        pending.resolve(response(200));
        await new Promise(resolve => setImmediate(resolve));
      });
      assert.match(mounted.text, /Sign-in was superseded/);
      assert.equal(mounted.navigationCount, 0);
      assert.equal(env.oauth.getAccessToken(), null);
      assert.equal(await tokenFromNewTab(app, env), "new");
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: a bound sign-in denial clears only that session`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    env.localStorage.setItem(env.generationKey, "current");
    env.localStorage.setItem(`${env.tokenKey}:current`, token("current"));
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "current",
    }));
    env.window.location.href = "https://portal.example.test/oauth/callback?error=access_denied&state=state";
    const mounted = await mountAuthContext(app, env, { callback: true });
    try {
      assert.equal(env.oauth.hasSession(), false);
      assert.equal(mounted.navigationCount, 1);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: logout between token validation and storage cannot resurrect a session`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    env.localStorage.setItem(env.generationKey, "old");
    env.sessionStorage.setItem(env.pkceKey, JSON.stringify({
      verifier: "verifier", state: "state", generation: "old",
    }));
    const setItem = env.localStorage.setItem;
    env.localStorage.setItem = (key, value) => {
      setItem(key, value);
      if (key === `${env.tokenKey}:old`) env.oauth.clearAuthorization();
    };
    assert.equal((await env.oauth.handleCallback()).ok, false);
    assert.equal(env.oauth.hasSession(), false);
    assert.equal(env.localStorage.getItem(`${env.tokenKey}:old`), null);
  });

  test(`${app}: a token read interrupted by an account switch is discarded`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    const getItem = env.localStorage.getItem;
    env.localStorage.getItem = key => {
      const value = getItem(key);
      if (key === `${env.tokenKey}:old`) {
        env.localStorage.setItem(env.generationKey, "new");
        env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      }
      return value;
    };
    assert.equal(env.oauth.getAccessToken(), null);
    assert.equal(env.oauth.getAccessToken(), null);
    assert.equal(await tokenFromNewTab(app, env), "new");
  });

  test(`${app}: logout while PKCE is prepared prevents sign-in`, async () => {
    const digest = deferred();
    const crypto = {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: { digest: () => digest.promise },
    };
    const env = await loadOAuth(app, async () => response(200), crypto);
    const signIn = env.oauth.startSilentSignIn("user", "password");
    env.oauth.clearAuthorization();
    digest.resolve(new Uint8Array(32).buffer);
    await assert.rejects(signIn, /superseded/);
    assert.equal(env.sessionStorage.getItem(env.pkceKey), null);
  });

  test(`${app}: a superseded login cannot clear the newer login's pending identity`, async () => {
    const hashes = [deferred(), deferred()];
    let hashIndex = 0;
    const crypto = {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: { digest: () => hashes[hashIndex++].promise },
    };
    const env = await loadOAuth(app, async () => response(200), crypto);
    stubLoginForm(env);
    const pendingEmailKey = app === "app-admin"
      ? "adventureworks_admin_pending_email" : "adventureworks_manufacturing_pending_email";
    const mounted = await mountAuthContext(app, env);
    try {
      let old, current;
      await mounted.act(async () => {
        old = mounted.current.login("old@example.test", "password");
        current = mounted.current.login("new@example.test", "password");
      });
      hashes[0].resolve(new Uint8Array(32).buffer);
      await mounted.act(async () => assert.equal(await old, false));
      assert.equal(env.sessionStorage.getItem(pendingEmailKey), "new@example.test");
      hashes[1].resolve(new Uint8Array(32).buffer);
      await mounted.act(async () => assert.equal(await current, true));
      assert.equal(env.sessionStorage.getItem(pendingEmailKey), "new@example.test");
    } finally {
      await mounted.close();
    }
  });

  for (const status of [200, 400]) {
    test(`${app}: stale refresh ${status} neither replaces nor invalidates a new session`, async () => {
      const pending = deferred();
      const started = deferred();
      const env = await loadOAuth(app, () => { started.resolve(); return pending.promise; });
      env.localStorage.setItem(env.generationKey, "old");
      env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
      const refresh = env.oauth.refreshAccessToken(true);
      await started.promise;
      env.oauth.clearAuthorization();
      env.localStorage.setItem(env.generationKey, "new");
      env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      pending.resolve(response(status));
      assert.equal(await refresh, null);
      assert.equal(env.oauth.getAccessToken(), null);
      assert.equal(await tokenFromNewTab(app, env), "new");
      assert.equal(env.lost, 0);
      assert.equal(env.localStorage.getItem(`${env.tokenKey}:old`), null);
    });
  }

  for (const status of [200, 401]) {
    test(`${app}: stale Functions exchange ${status} leaves a new session intact`, async () => {
      const pending = deferred();
      const started = deferred();
      const env = await loadOAuth(app, () => { started.resolve(); return pending.promise; });
      env.localStorage.setItem(env.generationKey, "old");
      env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
      const exchange = env.oauth.getFunctionsAccessToken(true);
      await started.promise;
      env.oauth.clearAuthorization();
      env.localStorage.setItem(env.generationKey, "new");
      env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      pending.resolve(response(status));
      assert.equal(await exchange, null);
      assert.equal(env.oauth.getAccessToken(), null);
      assert.equal(await tokenFromNewTab(app, env), "new");
      assert.equal(env.lost, 0);
    });
  }

  if (app === "app-admin") {
    for (const status of [200, 401]) {
      test(`${app}: stale MCP exchange ${status} leaves a new session intact`, async () => {
        const pending = deferred();
        const started = deferred();
        const env = await loadOAuth(app, () => { started.resolve(); return pending.promise; });
        env.localStorage.setItem(env.generationKey, "old");
        env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
        const exchange = env.oauth.getMcpAccessToken(true);
        await started.promise;
        env.oauth.clearAuthorization();
        env.localStorage.setItem(env.generationKey, "new");
        env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
        pending.resolve(response(status));
        assert.equal(await exchange, null);
        assert.equal(env.oauth.getAccessToken(), null);
        assert.equal(await tokenFromNewTab(app, env), "new");
        assert.equal(env.lost, 0);
      });
    }
  }

  test(`${app}: a new generation does not coalesce with an old Functions exchange`, async () => {
    const pending = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    let calls = 0;
    const env = await loadOAuth(app, () => {
      const index = calls++;
      started[index].resolve();
      return pending[index].promise;
    });
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    const old = env.oauth.getFunctionsAccessToken(true);
    await started[0].promise;
    env.oauth.clearAuthorization();
    stubLoginForm(env);
    await env.oauth.startSilentSignIn("user", "password");
    const newGeneration = env.oauth.getAuthorizationGeneration();
    env.localStorage.setItem(`${env.tokenKey}:${newGeneration}`, token("new"));
    const current = env.oauth.getFunctionsAccessToken(true);
    await started[1].promise;
    pending[1].resolve(response(200, "new-functions"));
    assert.equal(await current, "new-functions");
    pending[0].resolve(response(200, "old-functions"));
    assert.equal(await old, null);
    assert.equal(await env.oauth.getFunctionsAccessToken(), "new-functions");
    assert.equal(env.oauth.getAccessToken(), "new");
    assert.equal(await tokenFromNewTab(app, env), "new");
  });

  test(`${app}: stale portal state cannot clear a different signed-in user`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    const oldUser = { id: "emp_old", firstName: "Old" };
    const newUser = { id: "emp_new", firstName: "New" };
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token("old"));
    env.localStorage.setItem(`${userKey}:old`, JSON.stringify(oldUser));
    const mounted = await mountAuthContext(app, env);
    try {
      assert.equal(mounted.current.user.id, oldUser.id);
      const staleLogout = mounted.current.logout;
      env.localStorage.setItem(env.generationKey, "new");
      env.localStorage.setItem(`${env.tokenKey}:new`, token("new"));
      env.localStorage.setItem(`${userKey}:new`, JSON.stringify(newUser));
      await mounted.act(async () => {
        assert.equal(mounted.current.completeSignIn("old"), false);
        staleLogout();
        env.window.dispatchEvent(new Event("storage"));
      });
      assert.equal(mounted.current.user, null);
      assert.equal(env.oauth.getAccessToken(), null);
      assert.equal(await tokenFromNewTab(app, env), "new");
      assert.equal(JSON.parse(env.localStorage.getItem(`${userKey}:new`)).id, newUser.id);
      assert.equal(env.localStorage.getItem(`${userKey}:old`), null);
    } finally {
      await mounted.close();
    }
  });

  test(`${app}: account switching during user creation cannot attach a stale profile`, async () => {
    const env = await loadOAuth(app, async () => response(200));
    const userKey = app === "app-admin" ? "adventureworks_admin_user" : "adventureworks_manufacturing_user";
    const jwt = `e30.${Buffer.from(JSON.stringify({ sub: "old", name: "Old User" })).toString("base64url")}.sig`;
    env.localStorage.setItem(env.generationKey, "old");
    env.localStorage.setItem(`${env.tokenKey}:old`, token(jwt));
    const mounted = await mountAuthContext(app, env);
    try {
      const setItem = env.localStorage.setItem;
      env.localStorage.setItem = (key, value) => {
        setItem(key, value);
        if (key === `${userKey}:old`) {
          setItem(env.generationKey, "new");
          setItem(`${env.tokenKey}:new`, token("new"));
          setItem(`${userKey}:new`, JSON.stringify({ id: "emp_new" }));
        }
      };
      await mounted.act(async () => assert.equal(mounted.current.completeSignIn("old"), false));
      assert.equal(mounted.current.user, null);
      assert.equal(env.localStorage.getItem(`${userKey}:old`), null);
      assert.equal(JSON.parse(env.localStorage.getItem(`${userKey}:new`)).id, "emp_new");
      assert.equal(env.oauth.getAccessToken(), null);
      assert.equal(await tokenFromNewTab(app, env), "new");
    } finally {
      await mounted.close();
    }
  });
}
