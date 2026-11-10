import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const ts = createRequire(new URL("../../app/package.json", import.meta.url))("typescript");
const proof = { token: "A".repeat(64), cartId: "guest-" + "a".repeat(32),
  expiresAt: new Date(Date.now() + 86400000).toISOString() };
const product = { ProductID: 1, Name: "Demo product", ListPrice: 10 };

async function loadProvider({ signedIn = true, initialGuest = proof } = {}) {
  let user = signedIn ? { businessEntityId: 7 } : null;
  let guest = initialGuest;
  let cursor = 0, dirty = true, value;
  const slots = [], effects = [], pending = [], queries = [], additions = [], errors = [];
  const listeners = new Map(), empty = [];
  const rows = new Map([["7", [{ ShoppingCartItemID: 7, ProductID: 1, Quantity: 7 }]],
    ["8", [{ ShoppingCartItemID: 8, ProductID: 1, Quantity: 8 }]]]);
  const same = (a, b) => a && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const memo = (action, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !same(previous.deps, deps)) slots[index] = { deps, value: action() };
    return slots[index].value;
  };
  const react = {
    createContext: () => ({ Provider: "provider" }),
    useContext: () => { throw new Error("Consumer hook is outside this provider harness"); },
    createElement: (type, props, children) => ({ type, props: { ...props, children } }),
    useState: (initial) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [slots[index].value, (next) => {
        slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
        dirty = true;
      }];
    },
    useRef: (initial) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: memo,
    useCallback: (action, deps) => memo(() => action, deps),
    useEffect: (action, deps) => {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: action() };
        });
      }
    },
  };
  const queryClient = Object.fromEntries(["cancelQueries", "removeQueries", "invalidateQueries"].map((name) =>
    [name, (options) => { queries.push({ name, key: JSON.parse(JSON.stringify(options.queryKey)) }); return Promise.resolve(); }]));
  let module;
  function flush() {
    let remaining = 20;
    while (dirty) {
      assert.ok(remaining-- > 0, "Provider effects did not stabilize");
      dirty = false;
      cursor = 0;
      value = module.namespace.CartProvider({ children: null }).props.value;
      for (const effect of effects.splice(0)) effect();
    }
  }
  const changed = () => {
    for (const action of listeners.get("guest-changed") ?? []) action();
    // Exercise proof retirement rendering before the awaiting merge continuation resumes.
    flush();
  };
  const dependencies = {
    react: { default: react, ...react },
    "@tanstack/react-query": { useQueryClient: () => queryClient },
    "@/types/product": { getSalePrice: () => null },
    "@/hooks/use-toast": { toast: () => {} },
    "@/components/ui/toast": { ToastAction: () => null },
    "@/context/AuthContext": { useAuth: () => ({ user }) },
    "@/context/LanguageContext": { useLanguage: () => ({ selectedLanguage: "en" }) },
    "@/hooks/useProducts": { useProductsByIds: () => ({ data: [product], isLoading: false }) },
    "@/lib/appInsights": { trackEvent: () => {}, trackError: (...args) => errors.push(args) },
    "@/hooks/useShoppingCart": {
      useShoppingCart: (id) => ({ data: rows.get(id) ?? empty, isLoading: false }),
      useAddToCart: () => ({ mutateAsync: async (item) => { additions.push(item); } }),
      useUpdateCartItem: () => ({}), useDeleteCartItem: () => ({}), useClearCart: () => ({}),
    },
    "@/services/ownedCart": {
      GUEST_CART_EVENT: "guest-changed", GUEST_CART_STORAGE_KEY: "guest",
      readGuestCartSession: () => guest,
      ensureGuestCartSession: async () => { guest = proof; changed(); return guest; },
      mergeGuestCartSession: (cartId, session) => new Promise((resolve, reject) => {
        pending.push({ cartId, session, resolve, reject });
      }).then(() => {
        if (guest?.token === session.token) { guest = null; changed(); }
      }),
    },
  };
  const context = vm.createContext({ window: {
    addEventListener: (name, action) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(action);
    },
    removeEventListener: (name, action) => listeners.get(name)?.delete(action),
  } });
  const source = ts.transpileModule(
    await readFile(new URL("../../app/src/context/CartContext.tsx", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } },
  ).outputText;
  module = new vm.SourceTextModule(source, { context });
  await module.link(async (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const exports = dependencies[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, item] of Object.entries(exports)) this.setExport(key, item);
    }, { context });
  });
  await module.evaluate();
  flush();
  return {
    get value() { return value; }, get guest() { return guest; },
    pending, queries, additions, errors,
    setUser: (owner) => { user = owner ? { businessEntityId: owner } : null; dirty = true; flush(); },
    settle: async () => { await new Promise(setImmediate); flush(); },
  };
}

test("confirmed merge invalidates account data even when proof retirement renders first", async () => {
  const current = await loadProvider();
  assert.equal(current.pending.length, 1);
  assert.equal(current.pending[0].cartId, "7");
  assert.equal(current.value.isLoading, true);
  current.pending[0].resolve();
  await current.settle();
  assert.equal(current.guest, null);
  assert.equal(current.value.error, null);
  assert.equal(current.value.isLoading, false);
  assert.ok(current.queries.some((call) => call.name === "invalidateQueries" && call.key[1] === "7"));
});

test("account switches and logout evict prior carts and ignore stale merge failures", async () => {
  const current = await loadProvider();
  current.setUser(8);
  assert.equal(current.pending[1].cartId, "8");
  current.pending[0].reject(new Error("Old account request failed"));
  await current.settle();
  assert.equal(current.value.error, null);
  assert.equal(current.value.isLoading, true);
  assert.ok(current.queries.some((call) => call.name === "removeQueries" && call.key[1] === "7"));
  current.pending[1].resolve();
  await current.settle();
  assert.equal(current.value.items[0].quantity, 8);
  current.setUser(null);
  assert.equal(current.value.items.length, 0);
  assert.ok(current.queries.some((call) => call.name === "removeQueries" && call.key[1] === "8"));
});

test("failed merge exposes retry without discarding the guest proof", async () => {
  const current = await loadProvider();
  current.pending[0].reject(new Error("Temporary merge failure"));
  await current.settle();
  assert.equal(current.guest, proof);
  assert.equal(current.value.canRetryGuestMerge, true);
  assert.match(current.value.error, /Temporary merge failure/);
  current.value.retryGuestMerge();
  current.pending[1].resolve();
  await current.settle();
  assert.equal(current.value.error, null);
  assert.equal(current.value.canRetryGuestMerge, false);
  assert.equal(current.guest, null);
});

test("signed-out add creates a guest session and uses additive owned-cart mutation", async () => {
  const current = await loadProvider({ signedIn: false, initialGuest: null });
  await current.value.addToCart(product, 2);
  assert.equal(current.pending.length, 0);
  assert.equal(current.additions.length, 1);
  assert.equal(current.additions[0].shoppingCartId, proof.cartId);
  assert.equal(current.additions[0].quantity, 2);
});
