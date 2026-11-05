import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const ts = createRequire(new URL("../../app-admin/package.json", import.meta.url))("typescript");

async function loadSubscription() {
  const window = new EventTarget();
  const document = { visibilityState: "visible" };
  const timers = new Map();
  const errors = [];
  const delays = [];
  let sequence = 0;
  const context = vm.createContext({
    window, document, CustomEvent,
    setTimeout: (callback, delay) => { delays.push(delay); timers.set(++sequence, callback); return sequence; },
    clearTimeout: id => timers.delete(id),
    console: { error: (...args) => errors.push(args) },
  });
  const source = await readFile(new URL("../../app-admin/src/lib/liveUpdates.ts", import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  await module.link(() => { throw new Error("Unexpected dependency"); });
  await module.evaluate();
  const emit = detail => window.dispatchEvent(new CustomEvent("webpubsub", { detail }));
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const flushTimers = async () => {
    const batch = [...timers.values()];
    timers.clear();
    for (const callback of batch) callback();
    await settle();
  };
  return { subscribe: module.namespace.subscribeLiveUpdates, window, document, timers, errors, delays, emit, settle, flushTimers };
}

test("initial read then zero idle requests; irrelevant and malformed events are ignored", async () => {
  const env = await loadSubscription();
  let reads = 0;
  const stop = env.subscribe(["orders"], () => { reads++; });
  await env.settle();
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
  env.emit({ group: "reviews" });
  env.emit(null);
  env.emit({ group: 42 });
  await env.flushTimers();
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
  stop();
});

test("bursts coalesce without postponing reads until a quiet period", async () => {
  const env = await loadSubscription();
  let reads = 0;
  const stop = env.subscribe(["warehouse"], () => { reads++; });
  await env.settle();
  for (let i = 0; i < 100; i++) env.emit({ group: "warehouse" });
  assert.equal(env.timers.size, 1);
  await env.flushTimers();
  assert.equal(reads, 2);
  for (let i = 0; i < 100; i++) env.emit({ group: "warehouse" });
  await env.flushTimers();
  assert.equal(reads, 3);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.delays, [250, 250]);
  stop();
});

test("events during an in-flight read schedule one follow-up, never overlapping reads", async () => {
  const env = await loadSubscription();
  let finish;
  let reads = 0;
  const stop = env.subscribe(["shopping-simulator"], () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { finish = resolve; });
  });
  for (let i = 0; i < 10; i++) env.emit({ group: "shopping-simulator" });
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
  finish();
  await env.settle();
  assert.equal(env.timers.size, 1);
  await env.flushTimers();
  assert.equal(reads, 2);
  stop();
});

test("job events filter instance identity; reconnect and visible focus recover missed changes", async () => {
  const env = await loadSubscription();
  let reads = 0;
  const stop = env.subscribe(["utilities"], () => { reads++; }, update => update.instanceId === "current");
  await env.settle();
  env.emit({ group: "utilities", instanceId: "other", event: "completed" });
  await env.flushTimers();
  assert.equal(reads, 1);
  env.emit({ group: "utilities", instanceId: "current", event: "completed" });
  await env.flushTimers();
  assert.equal(reads, 2);
  env.window.dispatchEvent(new Event("webpubsub-reconnected"));
  await env.flushTimers();
  assert.equal(reads, 3);
  env.document.visibilityState = "hidden";
  env.window.dispatchEvent(new Event("focus"));
  await env.flushTimers();
  assert.equal(reads, 3);
  env.document.visibilityState = "visible";
  env.window.dispatchEvent(new Event("focus"));
  await env.flushTimers();
  assert.equal(reads, 4);
  stop();
});

test("cleanup cancels batched work and all listeners, including an in-flight completion", async () => {
  const env = await loadSubscription();
  let reads = 0;
  let finish;
  const stop = env.subscribe(["reviews"], () => {
    reads++;
    return new Promise(resolve => { finish = resolve; });
  });
  env.emit({ group: "reviews" });
  stop();
  finish();
  await env.settle();
  env.emit({ group: "reviews" });
  env.window.dispatchEvent(new Event("webpubsub-reconnected"));
  env.window.dispatchEvent(new Event("focus"));
  await env.flushTimers();
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
});

test("failed reads are reported, do not poll/retry silently, and recover on a new event", async () => {
  const env = await loadSubscription();
  let reads = 0;
  const stop = env.subscribe(["orders"], () => {
    reads++;
    if (reads === 1) throw new Error("unavailable");
  });
  await env.settle();
  assert.equal(env.errors.length, 1);
  assert.equal(env.timers.size, 0);
  env.emit({ group: "orders" });
  await env.flushTimers();
  assert.equal(reads, 2);
  stop();
});

test("storefront cart invalidates on push and reconnect without an interval", async () => {
  const invalidations = [];
  const pendingReads = [];
  const timers = [];
  let subscription;
  const context = vm.createContext({ setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {} });
  const source = await readFile(new URL("../../app/src/hooks/useRealTimeUpdates.ts", import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  await module.link(name => {
    const exports = name === "@tanstack/react-query"
      ? { useQueryClient: () => ({ invalidateQueries: (...args) => {
          invalidations.push(args);
          return new Promise(resolve => pendingReads.push(resolve));
        } }) }
      : name === "react"
        ? { useEffect: callback => callback(), useRef: value => ({ current: value }) }
        : { useWebPubSub: (groups, onMessage, onConnected) => { subscription = { groups, onMessage, onConnected }; } };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.useRealTimeUpdates();
  subscription.onMessage("orders", { event: "cart-changed" });
  subscription.onConnected();
  assert.equal(invalidations.length, 0);
  assert.equal(timers.length, 1);
  timers.shift()();
  subscription.onMessage("orders", { event: "cart-changed" });
  subscription.onMessage("orders", { event: "cart-changed" });
  assert.equal(timers.length, 0);
  pendingReads.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(invalidations.length, 1);
  assert.equal(timers.length, 1);
  timers.shift()();
  pendingReads.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(invalidations.length, 2);
  assert.equal(timers.length, 0);
  assert.ok(invalidations.every(([filter, options]) => filter.queryKey[0] === "shoppingCart" && options.cancelRefetch === false));
  const cart = await readFile(new URL("../../app/src/hooks/useShoppingCart.ts", import.meta.url), "utf8");
  assert.ok(!cart.includes("refetchInterval"));
});

test("frontends contain no recurring network polling; only verified display clocks retain intervals", async () => {
  async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) {
        await check(url);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true);
        function visit(node) {
          if (ts.isPropertyAssignment(node)) {
            const name = node.name.getText(source).replace(/["']/g, "");
            assert.ok(!["refetchInterval", "refetchIntervalInBackground"].includes(name), `${url.pathname}: ${name}`);
          }
          if (ts.isCallExpression(node) && /(^|\.)setInterval$/.test(node.expression.getText(source))) {
            assert.ok(["UtilityStatusPanel.tsx", "HealthCheckPage.tsx"].includes(entry.name),
              `${url.pathname}: interval is not a display clock`);
            const callback = node.arguments[0];
            assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)));
            function clockOnly(child) {
              if (ts.isCallExpression(child)) {
                assert.ok(["setElapsedTime", "setNow", "Date.now"].includes(child.expression.getText(source)),
                  `${url.pathname}: interval calls ${child.expression.getText(source)}`);
              }
              ts.forEachChild(child, clockOnly);
            }
            clockOnly(callback);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  for (const app of ["app", "app-admin", "app-manufacturing"]) {
    await check(new URL(`../../${app}/src/`, import.meta.url));
  }
});

async function loadSocket(app, fetchResponse) {
  const timers = new Map();
  const warnings = [];
  const clients = [];
  const cleanups = [];
  let fetches = 0;
  class Client {
    handlers = {};
    constructor() { clients.push(this); }
    on(name, handler) { this.handlers[name] = handler; }
    async start() { this.handlers.connected(); }
    stop() { this.handlers.stopped(); }
  }
  const context = vm.createContext({
    window: new EventTarget(), Event, AbortController,
    console: { warn: (...args) => warnings.push(args) },
    fetch: (...args) => { fetches++; return fetchResponse(...args); },
    setTimeout: (callback, delay) => { timers.set(delay, callback); return delay; },
    clearTimeout: id => timers.delete(id),
  });
  const source = await readFile(new URL(`../../${app}/src/hooks/useWebPubSub.ts`, import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  await module.link(async name => {
    const exports = name === "react"
      ? { useRef: value => ({ current: value }), useEffect: callback => { cleanups.push(callback()); } }
      : name === "@azure/web-pubsub-client"
        ? { WebPubSubClient: Client }
        : { getFunctionsApiUrl: () => "https://functions.example", getWebPubSubNegotiateUrl: () => "https://functions.example/api/webpubsub/negotiate" };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { api: module.namespace, timers, warnings, clients, cleanups, settle, fetches: () => fetches };
}

for (const app of ["app", "app-admin"]) {
  test(`${app} socket reports availability, rejects malformed messages and ignores cleanup-time events`, async () => {
    const env = await loadSocket(app, async () => ({ ok: true, json: async () => ({ url: "wss://socket.example" }) }));
    const messages = [];
    env.api.useWebPubSub(["orders"], (...args) => messages.push(args));
    await env.settle();
    assert.equal(env.api.getWebPubSubStatus(), "connected");
    assert.equal(env.timers.size, 0);
    const client = env.clients[0];
    const emit = data => client.handlers["group-message"]({ message: { group: "orders", data } });
    emit("not-json");
    emit("null");
    emit("[]");
    assert.equal(messages.length, 0);
    assert.equal(env.warnings.length, 3);
    emit('{"event":"cart-changed"}');
    assert.equal(messages.length, 1);
    client.handlers.disconnected();
    assert.equal(env.api.getWebPubSubStatus(), "disconnected");
    client.handlers.connected();
    assert.equal(env.api.getWebPubSubStatus(), "connected");
    client.handlers["rejoin-group-failed"]();
    assert.equal(env.api.getWebPubSubStatus(), "failed");
    env.cleanups[0]();
    emit('{"event":"cart-changed"}');
    assert.equal(messages.length, 1);
    assert.equal(env.fetches(), 1);
    assert.equal(env.timers.size, 0);
  });

  test(`${app} negotiation failure/timeout are explicit and never schedule polling`, async () => {
    const missing = await loadSocket(app, async () => ({ ok: false, status: 503 }));
    missing.api.useWebPubSub(["orders"], () => {});
    await missing.settle();
    assert.equal(missing.api.getWebPubSubStatus(), "not-configured");
    assert.equal(missing.fetches(), 1);
    assert.equal(missing.timers.size, 0);
    missing.cleanups[0]();

    const timeout = await loadSocket(app, (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    timeout.api.useWebPubSub(["orders"], () => {});
    assert.equal(timeout.api.getWebPubSubStatus(), "connecting");
    assert.equal(timeout.timers.size, 1);
    timeout.timers.get(30_000)();
    await timeout.settle();
    assert.equal(timeout.api.getWebPubSubStatus(), "failed");
    assert.equal(timeout.fetches(), 1);
    assert.equal(timeout.timers.size, 0);
    timeout.cleanups[0]();
  });
}

test("durable utility completion is once per instance and late replaced/unmounted reads are ignored", async () => {
  const hooks = [];
  const effects = [];
  const reads = [];
  let index = 0;
  let subscription;
  const react = {
    useState: initial => {
      const slot = index++;
      hooks[slot] ??= { value: initial };
      return [hooks[slot].value, value => { hooks[slot].value = value; }];
    },
    useRef: value => {
      const slot = index++;
      hooks[slot] ??= { current: value };
      return hooks[slot];
    },
    useCallback: callback => callback,
    useEffect: (callback, dependencies) => {
      const slot = index++;
      if (!hooks[slot] || dependencies.some((value, i) => value !== hooks[slot].dependencies[i])) {
        effects.push(() => {
          hooks[slot]?.cleanup?.();
          hooks[slot] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const context = vm.createContext({});
  const source = await readFile(new URL("../../app-admin/src/components/UtilityStatusPanel.tsx", import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { context });
  await module.link(async name => {
    const exports = name === "react" ? { ...react, default: react }
      : name === "react/jsx-runtime" ? { jsx: () => ({}), jsxs: () => ({}), Fragment: () => ({}) }
      : name === "@/hooks/useLiveUpdates" ? { useLiveUpdates: (...args) => { subscription = args; } }
      : name === "@/services/utilityService" ? {
          getOrchestrationStatus: () => new Promise(resolve => reads.push(resolve)),
          terminateOrchestration: async () => {},
        }
      : name === "sonner" ? { toast: () => {} }
      : name === "lucide-react" ? Object.fromEntries(
          ["Loader2", "CheckCircle2", "XCircle", "Clock", "Copy", "Square", "ChevronDown", "ChevronUp"].map(icon => [icon, () => {}]),
        )
      : { Button: () => {} };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  let completions = 0;
  const render = id => {
    index = 0;
    module.namespace.default({
      jobResponse: { id, statusQueryGetUri: `https://status.example/${id}` },
      onComplete: () => completions++,
    });
    while (effects.length) effects.shift()();
  };
  render("first");
  assert.equal(subscription[4], "first");
  assert.equal(subscription[3]({ instanceId: "other" }), false);
  let read = subscription[1]();
  reads.shift()({ runtimeStatus: "Completed" });
  await read;
  read = subscription[1]();
  reads.shift()({ runtimeStatus: "Completed" });
  await read;
  assert.equal(completions, 1);

  render("second");
  read = subscription[1]();
  render("third");
  reads.shift()({ runtimeStatus: "Completed" });
  await read;
  assert.equal(completions, 1);
  assert.equal(hooks[0].value, null);
  assert.equal(subscription[4], "third");

  read = subscription[1]();
  for (const hook of hooks) hook?.cleanup?.();
  reads.shift()({ runtimeStatus: "Completed" });
  await read;
  assert.equal(completions, 1);
});
