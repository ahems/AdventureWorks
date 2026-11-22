import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const ts = require("typescript");
const { z } = require("zod");

async function loadPayments({ response = [], status = 200, user = { businessEntityId: 71 } } = {}) {
  const calls = [];
  const errors = [];
  const updates = [];
  let state = 0;
  const dependencies = {
    react: {
      useState: () => [state++ === 0 ? [] : false, value => updates.push(value)],
      useCallback: callback => callback,
      useEffect: () => {},
    },
    zod: { z },
    "@/context/AuthContext": { useAuth: () => ({ user }) },
    "@/lib/utils": {
      getFunctionsApiUrl: () => "https://functions.example.test",
      getRestApiUrl: () => "https://dab.example.test/api",
    },
    "@/services/functionsAuth": { functionsFetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(response), { status });
    } },
    "@/lib/dabFetch": { dabFetch: () => { throw new Error("Unexpected DAB payment read"); } },
    "@/lib/appInsights": { trackError: (...args) => errors.push(args) },
  };
  const source = ts.transpileModule(
    await readFile(new URL("../../app/src/hooks/usePaymentMethods.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const module = new vm.SourceTextModule(source, { context: vm.createContext({}) });
  await module.link(async name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const values = dependencies[name];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context: module.context });
  });
  await module.evaluate();
  return { hook: module.namespace.usePaymentMethods(), calls, errors, updates };
}

test("saved payment cards use the person-bound Functions route and only masked fields", async () => {
  const { hook, calls, errors, updates } = await loadPayments({
    response: [{ id: 1, cardType: "Vista", last4: "1234", expMonth: 12, expYear: 2030 }],
  });
  await hook.refetch();
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://functions.example.test/api/payment-methods");
  const rows = updates.find(Array.isArray);
  assert.equal(rows[0].cardLast4, "1234");
  assert.equal(rows[0].cardBrand, "Visa");
  assert.equal(rows[0].cardExpiry, "12/2030");
  assert.equal(Object.hasOwn(rows[0], "CardNumber"), false);
});

test("unsigned users never fetch payment cards", async () => {
  const { hook, calls } = await loadPayments({ user: null });
  await hook.refetch();
  assert.equal(calls.length, 0);
});

test("HTTP errors and unmasked or invalid payloads are reported instead of rendered", async () => {
  for (const options of [
    { status: 403 },
    { response: {} },
    { response: [{ id: 1, cardType: "Vista", last4: "1111222233334444", expMonth: 12, expYear: 2030 }] },
    { response: [{ id: 1, cardType: "Vista", last4: "1234", expMonth: 12, expYear: 2030, CardNumber: "synthetic" }] },
  ]) {
    const { hook, errors, updates } = await loadPayments(options);
    await hook.refetch();
    assert.equal(errors.length, 1);
    assert.equal(updates.filter(Array.isArray).every(rows => rows.length === 0), true);
  }
});

test("saving a card posts only brand, last four and expiry for a known test card", async () => {
  const { hook, calls, errors } = await loadPayments({ response: [] });
  const result = await hook.addPaymentMethod({
    type: "card", cardNumber: "4242 4242 4242 4242", cardExpiry: "12/99", cardholderName: "Synthetic Shopper",
  });
  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(errors.length, 0);
  assert.equal(calls[0].url, "https://functions.example.test/api/payment-methods");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { cardType: "Vista", last4: "4242", expMonth: 12, expYear: 2099 });
  assert.equal(calls[0].options.body.includes("4242424242424242"), false);
  assert.equal(calls.length, 2, "the list is re-read after saving");
});

test("non-test, invalid or expired cards are never sent", async () => {
  for (const [cardNumber, cardExpiry, reason] of [
    ["4000 1234 5678 9017", "12/99", "not-test-card"],
    ["4242 4242 4242 4241", "12/99", "invalid-card"],
    ["4242 4242 4242 4242", "01/20", "expired"],
  ]) {
    const { hook, calls } = await loadPayments();
    assert.deepEqual({ ...(await hook.addPaymentMethod({ type: "card", cardNumber, cardExpiry })) }, { ok: false, reason });
    assert.equal(calls.length, 0);
  }
});

test("failed saves resolve with a reported error instead of rejecting", async () => {
  const { hook, errors } = await loadPayments({ status: 400 });
  assert.deepEqual({ ...(await hook.addPaymentMethod({ type: "card", cardNumber: "5555555555554444", cardExpiry: "01/2099" })) },
    { ok: false, reason: "request-failed" });
  assert.equal(errors.length, 1);
});
