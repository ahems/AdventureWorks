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

test("review moderation reports stopped jobs without claiming completion", async () => {
  const source = await readFile(new URL("../../app-admin/src/pages/ReviewsPage.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("ReviewsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "refreshReviewModerationStatus") {
      assert.ok(ts.isCallExpression(node.initializer));
      callback = node.initializer.arguments[0].getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(callback);
  const code = ts.transpileModule(`globalThis.refresh = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const run = async status => {
    const notifications = [];
    const invalidations = [];
    const context = {
      getReviewModerationStatus: async () => status,
      startingModerationRef: { current: false },
      activeModerationJobIdRef: { current: "job-1" },
      notifyModerationCompletionRef: { current: true },
      setIsAnalyzeApproveAllRunning: () => {},
      setAnalyzeApproveAllProgress: () => {},
      queryClient: { invalidateQueries: value => invalidations.push(value) },
      toast: value => notifications.push(value),
      console,
    };
    vm.runInNewContext(code, context);
    await context.refresh();
    assert.equal(invalidations.length, 1);
    assert.equal(notifications.length, 1);
    return notifications[0];
  };
  const stopped = await run({
    isRunning: false, jobId: "job-1", queuedCount: 3, processedCount: 2,
    successCount: 1, failedCount: 1, skippedCount: 0, lastError: "Policy violation.",
  });
  assert.equal(stopped.title, "Analyze & Approve Stopped");
  assert.equal(stopped.variant, "destructive");
  assert.match(stopped.description, /1 completed, 1 failed, 0 skipped\. Policy violation\./);

  const completed = await run({
    isRunning: false, jobId: "job-1", queuedCount: 2, processedCount: 2,
    successCount: 2, failedCount: 0, skippedCount: 0, lastError: null,
  });
  assert.equal(completed.title, "Analyze & Approve Complete");
  assert.match(completed.description, /2 reviews analyzed, replied, and approved\./);
});

test("bulk email generation stops and discards content after an agent policy violation", async () => {
  const source = await readFile(new URL("../../app-admin/src/components/BulkAiEmailDialog.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("BulkAiEmailDialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fragments = {};
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === "AgentToolPolicyError")
      fragments.error = node.getText(file);
    if (ts.isVariableDeclaration(node) &&
        ["generateAIEmailContent", "handleGenerateAll", "allSent"].includes(node.name.getText(file)))
      fragments[node.name.getText(file)] = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(fragments.error && fragments.generateAIEmailContent && fragments.handleGenerateAll && fragments.allSent);
  const code = ts.transpileModule(`
    ${fragments.error}
    const generateAIEmailContent = ${fragments.generateAIEmailContent};
    globalThis.generate = ${fragments.handleGenerateAll};
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  const run = async policyFailure => {
    const selectedCustomers = [1, 2, 3].map(CustomerID => ({
      CustomerID, FirstName: "Synthetic", EmailAddress: `synthetic${CustomerID}@example.test`,
    }));
    let statuses = selectedCustomers.map(customer => ({ customerId: customer.CustomerID, status: "pending" }));
    let generated;
    let generating = false;
    const calls = [];
    const notices = [];
    const context = {
      selectedCustomers, selectedTemplate: "stale_cart", allOrders: [], allCarts: [],
      getFunctionsApiUrl: () => "https://functions.example.test",
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 2) {
          return policyFailure
            ? { ok: false, status: 502, json: async () => ({ code: "agent_tool_policy_violation" }) }
            : { ok: false, status: 502, json: async () => ({ code: "upstream_unavailable" }) };
        }
        return { ok: true, status: 200, json: async () => ({ subject: "Subject", body: "Body" }) };
      },
      setEmailStatuses: update => { statuses = typeof update === "function" ? update(statuses) : update; },
      setGeneratedEmails: value => { generated = value; },
      setPreviewCustomerId: () => {},
      setIsGenerating: value => { generating = value; },
      toast: { success: message => notices.push({ kind: "success", message }),
               error: message => notices.push({ kind: "error", message }) },
    };
    vm.runInNewContext(code, context);
    await context.generate();
    return { calls, statuses, generated, generating, notices };
  };

  const stopped = await run(true);
  assert.equal(stopped.calls.length, 2);
  assert.ok(stopped.calls.every(call => call.url.endsWith("/api/email/generate-ai-content")));
  assert.equal(stopped.generated.size, 0);
  assert.equal(stopped.generating, false);
  assert.equal(stopped.statuses[0].subject, undefined);
  assert.equal(stopped.statuses[1].status, "failed");
  assert.match(stopped.statuses[1].error, /policy violation/i);
  assert.equal(stopped.statuses[2].status, "pending");
  assert.equal(stopped.notices[0].kind, "error");
  assert.equal(stopped.notices.length, 1);
  assert.equal(vm.runInNewContext(fragments.allSent, {
    generatedEmails: stopped.generated, emailStatuses: [{ status: "failed" }],
  }), false);

  const ordinary = await run(false);
  assert.equal(ordinary.calls.length, 3);
  assert.equal(ordinary.generated.size, 2);
  assert.equal(ordinary.statuses[1].status, "failed");
  assert.equal(ordinary.notices[0].kind, "success");
});

test("verified review completion reports stopped and partially processed jobs honestly", async () => {
  const source = await readFile(new URL("../../app-admin/src/components/GenerateVerifiedReviewsWizardDialog.tsx", import.meta.url), "utf8");
  let stateValues;
  let stateIndex;
  const react = {
    useState: () => [stateValues[stateIndex++], () => {}],
    useRef: value => ({ current: value }),
    useCallback: callback => callback,
  };
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ document: { body: {} } });
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { context });
  await module.link(async name => {
    const exports = name === "react" ? { ...react, default: react }
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" }
      : name === "react-dom" ? { createPortal: content => content }
      : name === "@/hooks/useLiveUpdates" ? { useLiveUpdates: () => {} }
      : name === "@/services/utilityService" ? {
          getVerifiedReviewsSummary: () => {}, startBatchVerifiedReviews: () => {},
          getVerifiedReviewsJobStatus: () => {},
        }
      : name === "lucide-react" ? Object.fromEntries(
          ["Star", "X", "Loader2", "CheckCircle", "AlertCircle", "AlertTriangle", "ExternalLink"].map(icon => [icon, icon]),
        )
      : { Skeleton: "Skeleton" };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const text = node => {
    if (node == null || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(text).join("");
    if (typeof node === "object") return text(node.props?.children);
    return String(node);
  };
  const render = job => {
    stateValues = [true, "done", null, false, null, 0, 1, job, false, null];
    stateIndex = 0;
    return text(module.namespace.default()).replace(/\s+/g, " ");
  };
  const failedReview = render({
    processedCount: 0, totalCount: 2, productsProcessed: 0, productsTotal: 2,
    lastError: "Tool policy rejected",
  });
  assert.match(failedReview, /Generation stopped/);
  assert.match(failedReview, /Processed 0 of 2 review requests/);
  assert.match(failedReview, /Generation stopped: Tool policy rejected/);
  assert.doesNotMatch(failedReview, /Done!|Generated 0/);

  const failedReply = render({
    processedCount: 1, totalCount: 1, productsProcessed: 0, productsTotal: 1,
    lastError: "Tool policy rejected",
  });
  assert.match(failedReply, /Generation stopped/);
  assert.match(failedReply, /0 of 1 products completed/);

  const completed = render({
    processedCount: 2, totalCount: 2, productsProcessed: 2, productsTotal: 2,
    lastError: null,
  });
  assert.match(completed, /Done!/);
  assert.match(completed, /Processed 2 of 2 review requests/);
  assert.doesNotMatch(completed, /Generation stopped/);
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

test("storefront cart and order history invalidate on push and reconnect without an interval", async () => {
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
  pendingReads.splice(0).forEach(resolve => resolve());
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(invalidations.length, 2);
  assert.equal(timers.length, 1);
  timers.shift()();
  pendingReads.splice(0).forEach(resolve => resolve());
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(invalidations.length, 4);
  assert.equal(timers.length, 0);
  assert.ok(invalidations.every(([filter, options]) => options.cancelRefetch === false));
  assert.equal(JSON.stringify(invalidations.slice(0, 2).map(([filter]) => filter.queryKey).sort()),
    '[["orders"],["shoppingCart"]]');
  const orders = await readFile(new URL("../../app/src/hooks/useOrders.ts", import.meta.url), "utf8");
  assert.match(orders, /queryKey: \["orders", customerId\]/);
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
  const requests = [];
  let generation = "test-session";
  let sessionGeneration = 0;
  const sessionListeners = new Set();
  let effect;
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
    fetch: (...args) => { fetches++; requests.push(args); return fetchResponse(...args); },
    setTimeout: (callback, delay) => { timers.set(delay, callback); return delay; },
    clearTimeout: id => timers.delete(id),
  });
  const source = await readFile(new URL(`../../${app}/src/hooks/useWebPubSub.ts`, import.meta.url), "utf8");
  const module = new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context });
  await module.link(async name => {
    const exports = name === "react"
      ? {
        useRef: value => ({ current: value }),
        useSyncExternalStore: (subscribe, getSnapshot) => { subscribe(() => {}); return getSnapshot(); },
        useEffect: (callback, dependencies) => {
          if (effect && dependencies.every((value, i) => value === effect.dependencies[i])) return;
          effect?.cleanup?.();
          effect = { dependencies, cleanup: callback() };
          cleanups.push(effect.cleanup);
        },
      }
      : name === "@azure/web-pubsub-client"
        ? { WebPubSubClient: Client }
        : name === "@/services/dabAuth" || name === "@/services/eshopOAuth"
          ? {
            getFunctionsAccessToken: async () => "test-functions-token",
            getEshopAccessToken: async () => "test-functions-token",
            getTabAuthorizationGeneration: () => generation,
            getEshopSessionGeneration: () => sessionGeneration,
            subscribeEshopSession: listener => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
            isTabAuthorizationGenerationCurrent: expected => expected === generation,
          }
        : { getFunctionsApiUrl: () => "https://functions.example", getWebPubSubNegotiateUrl: () => "https://functions.example/api/webpubsub/negotiate" };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { api: module.namespace, timers, warnings, clients, cleanups, requests, settle,
    setGeneration: value => { generation = value; }, fetches: () => fetches,
    changeEshopSession: () => { sessionGeneration++; sessionListeners.forEach(listener => listener()); } };
}

test("storefront re-negotiates after sign-in and sign-out and refreshes caches on the new socket", async () => {
  const env = await loadSocket("app", async () => ({ ok: true, json: async () => ({ url: "wss://socket.example" }) }));
  let connects = 0;
  const render = () => env.api.useWebPubSub(["orders"], () => {}, () => { connects++; });
  render();
  await env.settle();
  render();
  await env.settle();
  assert.equal(env.fetches(), 1);
  assert.equal(connects, 1);

  let stopped = 0;
  const first = env.clients[0];
  first.stop = () => { stopped++; };
  env.changeEshopSession();
  render();
  await env.settle();
  assert.equal(stopped, 1);
  assert.equal(env.fetches(), 2);
  assert.equal(env.clients.length, 2);
  assert.equal(connects, 2);
  assert.equal(env.api.getWebPubSubStatus(), "connected");
  assert.equal(env.timers.size, 0);
  env.cleanups.at(-1)();
});

for (const app of ["app", "app-admin"]) {
  if (app === "app-admin") test("admin does not negotiate after its session changes during token acquisition", async () => {
    const env = await loadSocket(app, async () => ({ ok: true, json: async () => ({ url: "wss://socket.example" }) }));
    env.api.useWebPubSub(["orders"], () => {});
    env.setGeneration("new-session");
    await env.settle();
    assert.equal(env.fetches(), 0);
    assert.notEqual(env.api.getWebPubSubStatus(), "connected");
    env.cleanups.forEach(cleanup => cleanup());
  });

  if (app === "app-admin") test("admin ignores socket events from a superseded session", async () => {
    const env = await loadSocket(app, async () => ({ ok: true, json: async () => ({ url: "wss://socket.example" }) }));
    const messages = [];
    env.api.useWebPubSub(["orders"], (...args) => messages.push(args));
    await env.settle();
    const client = env.clients[0];
    env.setGeneration("new-session");
    client.handlers.disconnected();
    client.handlers.connected();
    client.handlers["group-message"]({ message: { group: "orders", data: '{"event":"database-changed"}' } });
    assert.equal(env.api.getWebPubSubStatus(), "connected");
    assert.equal(messages.length, 0);
    env.cleanups[0]();
  });

  test(`${app} socket reports availability, rejects malformed messages and ignores cleanup-time events`, async () => {
    const env = await loadSocket(app, async () => ({ ok: true, json: async () => ({ url: "wss://socket.example" }) }));
    const messages = [];
    env.api.useWebPubSub(["orders"], (...args) => messages.push(args));
    await env.settle();
    assert.equal(env.api.getWebPubSubStatus(), "connected");
    assert.equal(env.requests[0][1].headers.Authorization, "Bearer test-functions-token");
    assert.equal(env.requests[0][0], "https://functions.example/api/webpubsub/negotiate");
    assert.equal(env.timers.size, 0);
    const client = env.clients[0];
    const emit = data => client.handlers["group-message"]({ message: { group: "orders", data } });
    emit("not-json");
    emit("null");
    emit("[]");
    client.handlers["group-message"]({ message: { group: "reviews", data: '{"event":"database-changed"}' } });
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
    await timeout.settle();
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
