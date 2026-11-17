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
