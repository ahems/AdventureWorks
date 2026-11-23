import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app-manufacturing/package.json", import.meta.url));
const ts = require("typescript");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function loadRequest(app, kind, nativeFetch, tokenGate) {
  const state = { generation: "old", refreshes: 0, tokenRequests: 0, session: true };
  const auth = {
    hasSession: () => state.session,
    getTabAuthorizationGeneration: () => state.generation,
    isTabAuthorizationGenerationCurrent: generation => generation === state.generation,
    getDabRole: () => "employee",
    getValidAccessToken: async () => {
      state.tokenRequests++;
      if (tokenGate) return tokenGate.promise;
      return state.refreshes ? "renewed" : `${state.generation}-dab`;
    },
    refreshAccessToken: async () => {
      state.refreshes++;
      return "renewed";
    },
    getFunctionsAccessToken: async force => {
      state.tokenRequests++;
      if (tokenGate) return tokenGate.promise;
      return force ? "renewed" : `${state.generation}-functions`;
    },
    getMcpAccessToken: async () => {
      state.tokenRequests++;
      if (tokenGate) return tokenGate.promise;
      return `${state.generation}-mcp`;
    },
  };
  const window = { fetch: nativeFetch };
  const context = vm.createContext({ window, fetch: nativeFetch, Headers, Request, Response, URL });
  const path = kind === "agent" ? "../../app-admin/src/services/agentService.ts"
    : kind === "functions"
    ? `../../${app}/src/services/functionsAuthInterceptor.ts`
    : app === "app-admin" ? "../../app-admin/src/lib/graphql-client.ts"
      : "../../app-manufacturing/src/lib/dabFetch.ts";
  let graphqlFetch;
  class GraphQLClient {
    constructor(_url, options) { graphqlFetch = options.fetch; }
  }
  const dependencies = {
    "@/services/dabAuth": auth,
    "@/lib/utils": {
      getFunctionsApiUrl: () => "https://functions.example.test",
      getApiUrl: () => "https://dab.example.test/graphql",
    },
    "@/config/api": { MANUFACTURING_BASE: "https://functions.example.test" },
    "@/lib/appInsights": {
      reportHandledFailure: () => {},
    },
    "graphql-request": { GraphQLClient },
  };
  const loaded = new Map();
  // Unstubbed "@/..." imports load the real app source so shared helpers stay under test.
  async function sourceModule(url) {
    if (loaded.has(url.href)) return loaded.get(url.href);
    const source = await readFile(url, "utf8");
    const module = new vm.SourceTextModule(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText, {
      context,
      identifier: url.href,
      initializeImportMeta(meta) {
        meta.env = {
          VITE_API_URL: "https://dab.example.test/graphql",
          VITE_API_FUNCTIONS_URL: "https://functions.example.test",
        };
      },
    });
    loaded.set(url.href, module);
    return module;
  }
  const linker = async specifier => {
    const exports = dependencies[specifier];
    if (exports) {
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    if (specifier.startsWith("@/")) {
      const appRoot = new URL(`../../${kind === "agent" ? "app-admin" : app}/src/`, import.meta.url);
      return sourceModule(new URL(`${specifier.slice(2)}.ts`, appRoot));
    }
    throw new Error(`Unexpected import: ${specifier}`);
  };
  const module = await sourceModule(new URL(path, import.meta.url));
  await module.link(linker);
  await module.evaluate();
  if (kind === "agent") {
    return { state, request: () => module.namespace.sendAgentMessage("test", []) };
  }
  if (kind === "functions") {
    module.namespace.installFunctionsAuthInterceptor();
    return { state, request: () => window.fetch("https://functions.example.test/api/example") };
  }
  return {
    state,
    request: app === "app-admin"
      ? () => graphqlFetch("https://dab.example.test/graphql", {})
      : () => module.namespace.dabFetch("https://dab.example.test/api/example"),
  };
}

test("admin: agent calls cannot dispatch or return across account switches", async () => {
  const tokenGate = deferred();
  let dispatches = 0;
  const first = await loadRequest("app-admin", "agent", async () => {
    dispatches++;
    return new Response('{"response":"ok"}', { status: 200 });
  }, tokenGate);
  const pendingToken = first.request();
  first.state.generation = "new";
  tokenGate.resolve("old-mcp");
  await assert.rejects(pendingToken, /session has expired/i);
  assert.equal(dispatches, 0);

  const responseGate = deferred();
  const started = deferred();
  const second = await loadRequest("app-admin", "agent", () => {
    started.resolve();
    return responseGate.promise;
  });
  const pendingResponse = second.request();
  await started.promise;
  second.state.generation = "new";
  responseGate.resolve(new Response('{"response":"old result"}', { status: 200 }));
  await assert.rejects(pendingResponse, /session has expired/i);
});

test("admin: agent call succeeds while its original session remains current", async () => {
  let authorization;
  const env = await loadRequest("app-admin", "agent", async (_input, init) => {
    authorization = new Headers(init.headers).get("Authorization");
    return new Response('{"response":"ok"}', { status: 200 });
  });
  assert.equal((await env.request()).content, "ok");
  assert.equal(authorization, "Bearer old-mcp");
});

for (const app of ["app-admin", "app-manufacturing"]) {
  for (const kind of ["dab", "functions"]) {
    test(`${app}: ${kind} request does not retry or return a stale result after an account switch`, async () => {
      for (const status of [200, 401]) {
        const pending = deferred();
        const started = deferred();
        const headers = [];
        const env = await loadRequest(app, kind, (_input, init) => {
          headers.push(new Headers(init?.headers).get("Authorization"));
          started.resolve();
          return pending.promise;
        });
        const request = env.request();
        await started.promise;
        env.state.generation = "new";
        pending.resolve(new Response("", { status }));
        await assert.rejects(request, /session has expired/i);
        assert.deepEqual(headers, [`Bearer old-${kind}`]);
        assert.equal(env.state.refreshes, 0);
        assert.equal(env.state.tokenRequests, 1);
      }
    });

    test(`${app}: ${kind} request does not dispatch after its token wait is superseded`, async () => {
      const tokenGate = deferred();
      let requests = 0;
      const env = await loadRequest(app, kind, async () => {
        requests++;
        return new Response("", { status: 200 });
      }, tokenGate);
      const request = env.request();
      env.state.generation = "new";
      tokenGate.resolve("old-token");
      await assert.rejects(request, /session has expired/i);
      assert.equal(requests, 0);
    });

    test(`${app}: ${kind} still retries a 401 within the same session`, async () => {
      const headers = [];
      const env = await loadRequest(app, kind, async (_input, init) => {
        headers.push(new Headers(init?.headers).get("Authorization"));
        return new Response("", { status: headers.length === 1 ? 401 : 200 });
      });
      assert.equal((await env.request()).status, 200);
      assert.deepEqual(headers, [`Bearer old-${kind}`, "Bearer renewed"]);
    });

    test(`${app}: ${kind} preserves anonymous requests when no session exists`, async () => {
      let authorization;
      const env = await loadRequest(app, kind, async (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return new Response("", { status: 200 });
      });
      env.state.session = false;
      assert.equal((await env.request()).status, 200);
      assert.equal(authorization, null);
      assert.equal(env.state.tokenRequests, 0);
    });
  }
}
