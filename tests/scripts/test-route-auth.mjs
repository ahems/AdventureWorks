import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app-manufacturing/package.json", import.meta.url));
const ts = require("typescript");
const originalError = console.error;
mock.method(console, "error", (...args) => {
  if (!String(args[0]).startsWith("Warning: useLayoutEffect does nothing on the server")) originalError(...args);
});

async function loadApp(app) {
  const appRequire = createRequire(new URL(`../../${app}/package.json`, import.meta.url));
  const React = appRequire("react");
  const { renderToString } = appRequire("react-dom/server");
  const router = appRequire("react-router-dom");
  const state = { isAuthenticated: false, isLoading: false, path: "/", pages: [], redirects: [], subscriptions: 0 };
  const context = vm.createContext({ console });
  const modules = new Map();
  const passthrough = ({ children }) => children;
  const source = await readFile(new URL(`../../${app}/src/App.tsx`, import.meta.url), "utf8");
  const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const paths = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.text === "path" && ts.isStringLiteral(node.initializer)) {
      paths.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);

  async function moduleFor(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    let module;
    if (specifier === "./components/RequireAuth" || specifier === "@/components/RequireAuth") {
      const code = await readFile(new URL(`../../${app}/src/components/RequireAuth.tsx`, import.meta.url), "utf8");
      module = new vm.SourceTextModule(ts.transpileModule(code, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText, { context });
    } else {
      let exports;
      if (specifier === "react/jsx-runtime") exports = appRequire("react/jsx-runtime");
      else if (specifier === "react") exports = { ...React, default: React };
      else if (specifier === "react-router-dom") exports = {
        ...router,
        BrowserRouter: ({ children }) => React.createElement(router.MemoryRouter, { initialEntries: [state.path] }, children),
        Navigate: props => { state.redirects.push(props); return null; },
      };
      else if (specifier === "@/context/AuthContext") exports = { AuthProvider: passthrough, useAuth: () => state };
      else if (specifier === "@tanstack/react-query") exports = { QueryClient: class {}, QueryClientProvider: passthrough };
      else if (specifier.includes("useRealTimeUpdates")) exports = {
        useRealTimeUpdates: () => { state.subscriptions++; return "live"; },
      };
      else if (specifier.includes("/pages/")) exports = {
        default: () => { state.pages.push(specifier); return React.createElement("span", null, specifier); },
      };
      else {
        const names = new Set(["default"]);
        const imports = source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g);
        for (const match of imports) if (match[2] === specifier) {
          for (const name of match[1].split(",")) names.add(name.trim().split(/\s+as\s+/)[0]);
        }
        exports = Object.fromEntries([...names].map(name => [name, name === "initAppInsights" ? () => {} : passthrough]));
        exports.AppInsightsContext = React.createContext(null);
        exports.Skeleton = passthrough;
      }
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    modules.set(specifier, module);
    await module.link(moduleFor);
    return module;
  }
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  await module.link(moduleFor);
  await module.evaluate();
  return {
    paths,
    state,
    render(path, authenticated = false, loading = false) {
      Object.assign(state, { path, isAuthenticated: authenticated, isLoading: loading, pages: [], redirects: [], subscriptions: 0 });
      renderToString(React.createElement(module.namespace.default));
      return state;
    },
  };
}

for (const app of ["app-admin", "app-manufacturing"]) {
  test(`${app}: every internal route redirects before pages and push mount; public OAuth routes work`, async () => {
    const env = await loadApp(app);
    for (const pattern of env.paths) {
      const path = pattern.replace(/:[^/]+/g, "123").replace("*", "/unknown-route");
      const result = env.render(path);
      if (path === "/login" || path === "/oauth/callback") {
        assert.equal(result.redirects.length, 0, path);
        assert.equal(result.pages.length, 1, path);
      } else {
        assert.equal(result.pages.length, 0, path);
        assert.equal(result.redirects[0]?.to, "/login", path);
        assert.equal(result.redirects[0]?.replace, true, path);
      }
      assert.equal(result.subscriptions, 0, path);
    }
  });

  test(`${app}: session restoration blocks data; deep-link state survives; signed-in views mount`, async () => {
    const env = await loadApp(app);
    const path = app === "app-admin" ? "/shopping-simulator?view=recent#results" : "/supply/orders/123?view=details#items";
    let result = env.render(path, false, true);
    assert.equal(result.pages.length, 0);
    assert.equal(result.redirects.length, 0);
    assert.equal(result.subscriptions, 0);
    result = env.render(path);
    assert.equal(result.redirects[0].state.returnTo, path);
    result = env.render(path, true);
    assert.equal(result.redirects.length, 0);
    assert.equal(result.pages.length, 1);
    assert.equal(result.subscriptions, 1);
    result = env.render(path, false);
    assert.equal(result.pages.length, 0);
    assert.equal(result.redirects[0].to, "/login");
  });
}

test("storefront: protected pages never mount signed out, while browsing and authentication remain public", async () => {
  const env = await loadApp("app");
  const protectedPaths = ["/account", "/checkout", "/order-confirmation", "/order-tracking", "/order-tracking/:orderId"];
  for (const pattern of env.paths) {
    const path = pattern.replace(/:[^/]+/g, "123").replace("*", "/unknown-route");
    const result = env.render(path);
    if (protectedPaths.includes(pattern)) {
      assert.equal(result.pages.length, 0, path);
      assert.equal(result.redirects[0]?.to, "/auth", path);
    } else {
      assert.equal(result.redirects.length, 0, path);
      assert.equal(result.pages.length, 1, path);
    }
  }
  const deepLink = "/order-tracking/75127?view=details#receipt";
  assert.deepEqual(
    JSON.parse(JSON.stringify(env.render(deepLink).redirects[0].state.from)),
    { pathname: "/order-tracking/75127", search: "?view=details", hash: "#receipt", state: null, key: "default" },
  );
  assert.equal(env.render(deepLink, false, true).pages.length, 0);
  assert.equal(env.render(deepLink, true).pages.length, 1);
});

async function loadOAuth(app, status) {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const window = new EventTarget();
  let lost = 0;
  window.addEventListener("dab-session-lost", () => lost++);
  const context = vm.createContext({
    window, localStorage: storage, sessionStorage: storage, Event, URL, URLSearchParams,
    fetch: async () => ({ ok: false, status, text: async () => "rejected" }),
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
    oauth: module.namespace, storage,
    tokenKey: `${prefix}dab_oauth_token`,
    pkceKey: `${prefix}dab_oauth_pkce`,
    get lost() { return lost; },
  };
}

for (const app of ["app-admin", "app-manufacturing"]) {
  test(`${app}: pending OAuth is not a session; expired nonrenewable tokens are signed out`, async () => {
    const env = await loadOAuth(app, 401);
    env.storage.setItem(env.pkceKey, JSON.stringify({ state: "pending" }));
    assert.equal(env.oauth.hasSession(), false);
    env.storage.setItem(env.tokenKey, JSON.stringify({ accessToken: "expired", expiresAt: 1 }));
    assert.equal(env.oauth.hasSession(), false);
    env.storage.setItem(env.tokenKey, JSON.stringify({ accessToken: "expired", expiresAt: 1, refreshToken: "renewable" }));
    assert.equal(env.oauth.hasSession(), true);
  });

  test(`${app}: rejected Functions refresh ends the session; server and permission errors do not`, async () => {
    for (const status of [400, 401, 403, 500]) {
      const env = await loadOAuth(app, status);
      env.storage.setItem(env.tokenKey, JSON.stringify({
        accessToken: "current", expiresAt: Date.now() / 1000 + 300, refreshToken: "renewable",
      }));
      assert.equal(await env.oauth.getFunctionsAccessToken(), null);
      const definitive = status === 400 || status === 401;
      assert.equal(env.lost, definitive ? 1 : 0, `status ${status}`);
      assert.equal(env.oauth.hasSession(), !definitive, `status ${status}`);
    }
  });
}
