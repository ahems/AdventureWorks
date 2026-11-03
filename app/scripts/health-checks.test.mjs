import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";

const source = readFileSync(new URL("../src/lib/healthChecks.ts", import.meta.url), "utf8");
function load(fetch, timerOverrides = {}) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, fetch, AbortController, performance, Date, Error,
    setTimeout, clearTimeout, ...timerOverrides,
  });
  return module.exports;
}
const config = { graphqlUrl: "https://dab.test/graphql/", functionsUrl: "https://functions.test/" };
const initial = load().initialHealthChecks();
function report() {
  return {
    status: "healthy", checkedAt: new Date().toISOString(),
    checks: initial.filter(check => !["graphql", "functions"].includes(check.id) &&
      (check.required || ["webpubsub-service", "files", "openai", "foundry", "manufacturing-agent",
        "email", "order-emails", "telemetry"].includes(check.id)))
      .map(check => ({ ...check, status: check.required ? "healthy" : "configured",
        message: "Probe passed", responseTimeMs: 1 })),
  };
}
function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => data };
}
function quickResponse(url) {
  if (url.endsWith("/readiness")) return response(report());
  if (url.endsWith("/api/health")) return response({ status: "healthy" });
  return response({ data: { productCategories: { items: [{ ProductCategoryID: 1 }] } } });
}
async function run(api, mode = "quick", signal = new AbortController().signal) {
  const results = [];
  await api.runHealthChecks(config, mode, signal, check => results.push(check));
  return results;
}

test("quick mode uses only three requests and never runs expensive probes", async () => {
  const calls = [];
  const api = load(async (url, options) => { calls.push([url, options]); return quickResponse(url); });
  const results = await run(api);
  assert.equal(calls.length, 3);
  assert.equal(results.length, api.checkIdsForMode("quick").length);
  assert.equal(api.overallHealth(results), "Core services operational");
  assert(!calls.some(([url]) => /semantic|suggestions|seed|sitemap|openapi|negotiate/.test(url)));
  assert(calls.find(([url]) => url.includes("graphql"))[1].body.includes("first: 1"));
});

test("4xx status is failed, never healthy", async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const results = await run(load(async () => response({}, status)));
    assert(results.every(check => check.status === "unhealthy"));
    assert(results.every(check => check.message.includes(`HTTP ${status}`)));
  }
});

test("valid 503 readiness report retains individual dependency states", async () => {
  const api = load(async url => {
    if (!url.endsWith("/readiness")) return quickResponse(url);
    const data = report();
    data.status = "unhealthy";
    data.checks.find(check => check.id === "sql").status = "unhealthy";
    return response(data, 503);
  });
  const results = await run(api);
  assert.equal(results.find(check => check.id === "sql").status, "unhealthy");
  assert.equal(results.find(check => check.id === "blobs").status, "healthy");
  assert.equal(api.overallHealth(results), "Core service issues detected");
});

test("missing or malformed dependency results are explicit failures", async () => {
  for (const corrupt of [
    data => data.checks.pop(),
    data => data.checks.push(data.checks[0]),
    data => { data.checkedAt = "not a date"; },
    data => { data.checks[0].status = "invented"; },
    data => { data.checks[0].responseTimeMs = -1; },
  ]) {
    const api = load(async url => {
      if (!url.endsWith("/readiness")) return quickResponse(url);
      const data = report();
      corrupt(data);
      return response(data);
    });
    const results = await run(api);
    assert.equal(results.find(check => check.id === "sql").status, "unhealthy");
  }
});

test("seed running and unknown remain distinct, optional states do not fail core", () => {
  const api = load();
  assert.equal(api.validateSeedStatus({ status: "running" }).status, "running");
  assert.equal(api.validateSeedStatus({ status: "unknown" }).status, "unknown");
  assert.equal(api.validateSeedStatus({ status: "failed" }).status, "unhealthy");
  assert.throws(() => api.validateSeedStatus({ status: "surprise" }), /Invalid seed/);
  const checks = initial.map(check => ({ ...check, status: check.required ? "healthy" : "unknown" }));
  assert.equal(api.overallHealth(checks), "Core services operational");
});

test("image metadata samples 100 rows, reports pagination and has no fixed count threshold", async () => {
  let query;
  const api = load(async (url, options) => {
    if (url.endsWith("/seed/status")) return response({ status: "unknown" });
    query = JSON.parse(options.body).query;
    return response({ data: { productPhotos: { items: [{ ProductPhotoID: 1001 }], hasNextPage: true } } });
  });
  const results = await run(api, "data");
  assert(query.includes("first: 100"));
  assert.equal(results.find(check => check.id === "images").status, "healthy");
  assert(results.find(check => check.id === "images").message.includes("1+"));
  assert(!source.includes("885"));
});

test("semantic network failure reaches a terminal state without retry or ReferenceError", async () => {
  const calls = [];
  const api = load(async url => { calls.push(url); throw new Error("Network failed"); });
  const results = await run(api, "capabilities");
  assert.equal(calls.filter(url => url.endsWith("/search/semantic")).length, 1);
  assert.equal(results.find(check => check.id === "semantic").status, "unhealthy");
  assert.equal(results.find(check => check.id === "semantic").message, "Network failed");
});

test("HTTP 200 with invalid functional payload is not a pass", async () => {
  const results = await run(load(async () => response({})), "capabilities");
  assert(results.every(check => check.status === "unhealthy"));
});

test("functional JSON checks accept real response shapes and empty search is unknown", async () => {
  for (const emptySearch of [false, true]) {
    const api = load(async url => {
      if (url.endsWith("/search/semantic"))
        return response({ results: emptySearch ? [] : [{ productID: 1 }] });
      if (url.includes("/search/suggestions")) return response({ suggestions: ["Mountain bike"] });
      if (url.endsWith("/agent/status")) return response({ status: "operational" });
      if (url.endsWith("/catalog-meta")) return response({ colors: ["Red"], bikeSizes: ["42"] });
      if (url.endsWith("/openapi.json")) return response({ info: { title: "API" }, paths: { "/api/health": {} } });
      return response("not XML");
    });
    const results = await run(api, "capabilities");
    assert.equal(results.find(check => check.id === "semantic").status, emptySearch ? "unknown" : "healthy");
    for (const id of ["suggestions", "agent-status", "catalog-meta", "openapi"])
      assert.equal(results.find(check => check.id === id).status, "healthy");
    assert.equal(results.find(check => check.id === "sitemap").status, "unhealthy");
  }
});

test("GraphQL errors and malformed lists fail", async () => {
  for (const data of [{ errors: [{ message: "broken" }] }, { data: { productCategories: {} } }]) {
    const results = await run(load(async url => url.includes("graphql") ? response(data) : quickResponse(url)));
    assert.equal(results.find(check => check.id === "graphql").status, "unhealthy");
  }
});

test("deadlines cover response-body reads and clear timers after failure", async () => {
  let cleared = 0;
  const api = load(async (url, options) => ({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }), {
    setTimeout: callback => setTimeout(callback, 5),
    clearTimeout: id => { cleared++; clearTimeout(id); },
  });
  const results = await run(api);
  assert(results.every(check => check.status === "timeout"));
  assert.equal(cleared, 3);
});

test("cancellation suppresses results after leaving the page", async () => {
  const controller = new AbortController();
  const api = load(async () => { controller.abort(); throw new Error("aborted"); });
  assert.equal((await run(api, "quick", controller.signal)).length, 0);
});

test("page has no reload, polling, or fixed threshold and uses shared socket status", () => {
  const page = readFileSync(new URL("../src/pages/HealthCheckPage.tsx", import.meta.url), "utf8");
  assert(!page.includes("location.reload") && !page.includes("refetchInterval"));
  assert(page.includes("useSyncExternalStore"));
  assert(page.includes("aria-valuenow={Math.round(progress)}"));
  assert(page.includes("max-w-full whitespace-normal"));
  assert(page.includes("Run quick checks again") && page.includes('run("capabilities", true)') && page.includes('run("data", true)'));
});

function renderHealthPage(reducedMotion = false) {
  const api = load();
  const runs = [];
  const pageSource = readFileSync(new URL("../src/pages/HealthCheckPage.tsx", import.meta.url), "utf8");
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(pageSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports, AbortController, Date,
    window: { matchMedia: () => ({ matches: reducedMotion }) },
    require: name => {
      if (name === "react/jsx-runtime") return {
        jsx: (type, props, key) => React.createElement(type, { ...props, key }),
        jsxs: (type, props, key) => React.createElement(type, { ...props, key }),
      };
      if (name === "react") return {
        useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
        useRef: initial => ({ current: initial }), useEffect: () => {},
        useSyncExternalStore: () => "connected",
      };
      if (name === "react-router-dom") return { Link: "a" };
      if (name === "lucide-react") return Object.fromEntries(
        ["Activity", "ArrowLeft", "Check", "Clock", "AlertCircle"].map(key => [key, "svg"]));
      if (name === "@/lib/utils") return {
        getGraphQLApiUrl: () => config.graphqlUrl, getFunctionsApiUrl: () => config.functionsUrl,
      };
      if (name === "@/lib/appInsights") return { trackError: () => {} };
      if (name === "@/lib/healthChecks") return {
        ...api, runHealthChecks: async (config, mode) => { runs.push(mode); },
      };
      if (name === "@/hooks/useWebPubSub") return {
        getWebPubSubStatus: () => "connected", subscribeWebPubSubStatus: () => () => {},
      };
      if (name.startsWith("@/components/ui/")) return Object.fromEntries(
        ["Card", "CardContent", "CardDescription", "CardHeader", "CardTitle", "Badge", "Button", "Progress"]
          .map(key => [key, key]));
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { tree: module.exports.default(), api, runs };
}

function elements(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => elements(child, predicate)),
  ];
}

test("each test appears once under the run button's matching colored section", () => {
  const { tree, api, runs } = renderHealthPage();
  const sections = elements(tree, element => element.type === "section");
  assert.equal(sections.length, 3);
  const allIds = [];
  const themes = new Set();
  for (const section of sections) {
    const mode = section.props.id.replace("-tests", "");
    const cards = elements(section, element => typeof element.type === "function" && element.props.check);
    assert.deepEqual(cards.map(card => card.props.check.id), Array.from(api.checkIdsForMode(mode)));
    for (const card of cards) {
      const rendered = card.type(card.props);
      assert.equal(rendered.props["data-test-type"], mode);
      allIds.push(card.props.check.id);
    }
    themes.add(section.props.className);
    const button = elements(tree, element => element.type === "Button" &&
      element.props["aria-controls"] === section.props.id)[0];
    assert(button);
    assert.equal(section.props.tabIndex, -1);
  }
  assert.equal(themes.size, 3);
  assert.equal(new Set(allIds).size, api.initialHealthChecks().length);
  assert.equal(allIds.length, api.initialHealthChecks().length);
  assert.equal(runs.length, 0);
});

test("clicking each run button focuses and scrolls to its tests, respecting reduced motion", () => {
  for (const reduced of [false, true]) {
    const { tree, runs } = renderHealthPage(reduced);
    for (const section of elements(tree, element => element.type === "section")) {
      const actions = [];
      section.props.ref({
        focus: options => actions.push(["focus", options.preventScroll]),
        scrollIntoView: options => actions.push(["scroll", options.behavior, options.block]),
      });
      const button = elements(tree, element => element.type === "Button" &&
        element.props["aria-controls"] === section.props.id)[0];
      button.props.onClick();
      assert.deepEqual(actions, [["focus", true], ["scroll", reduced ? "instant" : "smooth", "start"]]);
      assert.equal(runs.at(-1), section.props.id.replace("-tests", ""));
    }
  }
});

function loadWebPubSub(fetch) {
  let effect;
  let cleanup;
  const clients = [];
  const warnings = [];
  class Client {
    handlers = new Map();
    constructor() { clients.push(this); }
    on(event, listener) { this.handlers.set(event, listener); }
    async start() { this.handlers.get("connected")(); }
    stop() { this.stopped = true; this.handlers.get("stopped")(); }
  }
  const module = { exports: {} };
  const hook = readFileSync(new URL("../src/hooks/useWebPubSub.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(hook, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, fetch, AbortController, setTimeout, clearTimeout, Error,
    console: { warn: (...args) => warnings.push(args) },
    require: name => ({
      react: { useEffect: callback => { effect = callback; }, useRef: value => ({ current: value }) },
      "@azure/web-pubsub-client": { WebPubSubClient: Client },
      "@/lib/utils": { getFunctionsApiUrl: () => config.functionsUrl },
    })[name],
  });
  return { api: module.exports, clients, warnings,
    mount: () => { module.exports.useWebPubSub(["orders"], () => {}); cleanup = effect(); },
    cleanup: () => cleanup(),
  };
}

test("shared WebSocket status follows events without opening a diagnostic socket", async () => {
  let fetches = 0;
  const hook = loadWebPubSub(async () => { fetches++; return response({ url: "wss://pubsub.test/" }); });
  let notifications = 0;
  const unsubscribe = hook.api.subscribeWebPubSubStatus(() => { notifications++; });
  hook.mount();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(hook.api.getWebPubSubStatus(), "connected");
  assert.equal(fetches, 1);
  assert.equal(hook.clients.length, 1);
  hook.clients[0].handlers.get("disconnected")();
  assert.equal(hook.api.getWebPubSubStatus(), "disconnected");
  hook.clients[0].handlers.get("rejoin-group-failed")();
  assert.equal(hook.api.getWebPubSubStatus(), "failed");
  hook.cleanup();
  assert.equal(hook.clients[0].stopped, true);
  assert(notifications >= 3);
  unsubscribe();
});

test("negotiate failure and cleanup-before-response are visible or cancelled, not connected", async () => {
  const failed = loadWebPubSub(async () => response({}, 503));
  failed.mount();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failed.api.getWebPubSubStatus(), "not-configured");
  assert.equal(failed.clients.length, 0);
  assert.equal(failed.warnings.length, 1);
  failed.cleanup();

  let resolveFetch;
  const cancelled = loadWebPubSub(() => new Promise(resolve => { resolveFetch = resolve; }));
  cancelled.mount();
  cancelled.cleanup();
  resolveFetch(response({ url: "wss://pubsub.test/" }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled.clients.length, 0);
});
