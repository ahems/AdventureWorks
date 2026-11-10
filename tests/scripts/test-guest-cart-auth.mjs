import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const ts = createRequire(new URL("../../app/package.json", import.meta.url))("typescript");
const session = () => ({
  token: "A".repeat(64), cartId: "guest-" + "a".repeat(32),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});

async function loadCart(options = {}) {
  const calls = [], errors = [], events = [], audiences = [];
  const storage = new Map();
  let token = options.token ?? null;
  let lock = Promise.resolve();
  const context = vm.createContext({
    URL, Headers, Date, Event, AbortController,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    navigator: options.noLocks ? {} : { locks: { request: (_, action) => {
      const result = lock.then(action);
      lock = result.catch(() => {});
      return result;
    } } },
    window: { dispatchEvent: (event) => events.push(event.type) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.respond) return options.respond(url, init);
      return new Response(JSON.stringify(options.payload ?? session()), { status: options.status ?? 200 });
    },
  });
  const dependencies = {
    "@/lib/utils": { getFunctionsApiUrl: () => options.base ?? "https://functions.example.test/" },
    "@/services/eshopOAuth": { getEshopAccessToken: async (audience) => { audiences.push(audience); return token; } },
    "@/lib/appInsights": { trackError: (...args) => errors.push(args) },
  };
  const source = ts.transpileModule(
    await readFile(new URL("../../app/src/services/ownedCart.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const exports = dependencies[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const api = module.namespace;
  return { api, calls, errors, events, audiences, storage,
    setToken: (value) => { token = value; },
    save: (value) => storage.set(api.GUEST_CART_STORAGE_KEY, JSON.stringify(value)),
  };
}

test("guest bootstrap is serialized across concurrent callers and persists one server session", async () => {
  const { api, calls, events, audiences } = await loadCart();
  const [first, second] = await Promise.all([api.ensureGuestCartSession(), api.ensureGuestCartSession()]);
  assert.equal(first.token, second.token);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.has("Authorization"), false);
  assert.equal(audiences.length, 0);
  assert.deepEqual(events, [api.GUEST_CART_EVENT]);
});

test("unsupported browsers and malformed or expired saved sessions fail explicitly", async () => {
  const unsupported = await loadCart({ noLocks: true });
  await assert.rejects(unsupported.api.ensureGuestCartSession(), /Please sign in/);
  assert.equal(unsupported.calls.length, 0);
  for (const value of [
    { ...session(), token: ["A".repeat(64)] },
    { ...session(), expiresAt: "invalid" },
    { ...session(), expiresAt: new Date(Date.now() - 1).toISOString() },
    { ...session(), cartId: "123" },
  ]) {
    const current = await loadCart();
    current.save(value);
    assert.throws(() => current.api.readGuestCartSession(), /invalid|expired/);
    assert.equal(current.storage.size, 0);
  }
});

test("guest requests use only their capability, expected owner, no-store and redirect rejection", async () => {
  const current = await loadCart({ payload: [] });
  const guest = session();
  current.save(guest);
  await current.api.getShoppingCartItems(guest.cartId);
  const { url, init } = current.calls[0];
  assert.equal(new URL(url).searchParams.get("cartId"), guest.cartId);
  assert.equal(init.headers.get("X-Guest-Cart-Session"), guest.token);
  assert.equal(init.headers.has("Authorization"), false);
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(current.audiences, ["functions"]);
});

test("account access uses Functions tokens and cannot fall back to a guest cart after logout", async () => {
  const current = await loadCart({ token: "account-token", payload: [] });
  current.save(session());
  await current.api.getShoppingCartItems("7");
  assert.equal(current.calls[0].init.headers.get("Authorization"), "Bearer account-token");
  assert.equal(current.calls[0].init.headers.has("X-Guest-Cart-Session"), false);
  current.setToken(null);
  await assert.rejects(current.api.getShoppingCartItems("7"), /sign in again/);
  assert.equal(current.calls.length, 1);
});

test("untrusted URLs never receive cart capabilities or bearer tokens", async () => {
  for (const base of ["http://remote.example.test/", "https://user:password@functions.example.test/",
    "https://functions.example.test/?redirect=evil", "https://functions.example.test/#fragment"]) {
    const current = await loadCart({ base, token: "account-token", payload: [] });
    await assert.rejects(current.api.getShoppingCartItems("7"), /trusted HTTPS/);
    assert.equal(current.calls.length, 0);
    assert.equal(current.audiences.length, 0);
  }
});

test("a rejected guest capability is forgotten but failed merges always preserve the proof", async () => {
  const guest = await loadCart({ status: 401 });
  guest.save(session());
  await assert.rejects(guest.api.getShoppingCartItems(session().cartId), /HTTP 401/);
  assert.equal(guest.storage.size, 0);
  for (const status of [401, 403, 409, 500]) {
    const current = await loadCart({ status, token: "account-token" });
    const proof = session();
    current.save(proof);
    await assert.rejects(current.api.mergeGuestCartSession("7", proof), /HTTP/);
    assert.equal(current.api.readGuestCartSession().token, proof.token);
    assert.equal(current.errors.length, 1);
  }
});

test("merge retries share one request and retire local proof only after confirmed success", async () => {
  const current = await loadCart({ token: "account-token", payload: { merged: true } });
  const proof = session();
  current.save(proof);
  const first = current.api.mergeGuestCartSession("7", proof);
  const second = current.api.mergeGuestCartSession("7", proof);
  assert.equal(first, second);
  await first;
  assert.equal(current.calls.length, 1);
  assert.equal(current.storage.size, 0);
  assert.equal(current.calls[0].init.headers.get("X-Guest-Cart-Session"), proof.token);
  assert.equal(new URL(current.calls[0].url).searchParams.get("cartId"), "7");
  const failed = await loadCart({ token: "account-token", payload: { merged: false } });
  failed.save(proof);
  await assert.rejects(failed.api.mergeGuestCartSession("7", proof), /did not confirm/);
  assert.equal(failed.storage.size, 1);
});

test("confirming an older merge cannot erase a newer guest session", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const current = await loadCart({ token: "account-token",
    respond: () => pending.then(() => new Response('{"merged":true}')) });
  const old = session(), newer = { ...session(), token: "B".repeat(64), cartId: "guest-" + "b".repeat(32) };
  current.save(old);
  const merge = current.api.mergeGuestCartSession("7", old);
  current.save(newer);
  release();
  await merge;
  assert.equal(current.api.readGuestCartSession().token, newer.token);
});

test("HTTP errors, invalid response shapes and unconfirmed deletion never become empty-cart success", async () => {
  for (const options of [{ status: 403 }, { payload: {} }, { payload: [{ Quantity: 1 }] }]) {
    const current = await loadCart(options);
    current.save(session());
    await assert.rejects(current.api.getShoppingCartItems(session().cartId));
  }
  const current = await loadCart({ payload: {} });
  current.save(session());
  await assert.rejects(current.api.deleteCartItem(1, session().cartId), /did not confirm deletion/);
  await assert.rejects(current.api.clearShoppingCart(session().cartId), /did not confirm deletion/);
});

test("query cancellation reaches fetch without changing the owner or credentials", async () => {
  const current = await loadCart({ payload: [] });
  current.save(session());
  const controller = new AbortController();
  await current.api.getShoppingCartItems(session().cartId, controller.signal);
  assert.equal(current.calls[0].init.signal, controller.signal);
});

test("malformed concurrent storage never leaks credential fragments through JSON parser errors", async () => {
  const current = await loadCart({ token: "account-token", payload: { merged: true } });
  const merge = current.api.mergeGuestCartSession("7", session());
  current.storage.set(current.api.GUEST_CART_STORAGE_KEY, '{"token":"sensitive-fragment');
  await assert.rejects(merge, (error) => {
    assert.match(error.message, /saved guest cart session is invalid/);
    assert.equal(error.message.includes("sensitive-fragment"), false);
    return true;
  });
  assert.equal(current.storage.size, 0);
});
