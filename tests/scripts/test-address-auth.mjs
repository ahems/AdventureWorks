import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const ts = require("typescript");

async function loadAddresses({ status = 204, user = { businessEntityId: 7 } } = {}) {
  const calls = [];
  const errors = [];
  const dependencies = {
    react: {
      useState: initial => [initial, () => {}],
      useCallback: callback => callback,
      useEffect: () => {},
      useRef: current => ({ current }),
    },
    "@/context/AuthContext": { useAuth: () => ({ user }) },
    "@/lib/utils": {
      getFunctionsApiUrl: () => "https://functions.example.test",
      getRestApiUrl: () => "https://dab.example.test/api",
    },
    "@/lib/dabFetch": { dabFetch: async (url, options) => {
      calls.push({ service: "dab", url, options });
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    } },
    "@/services/functionsAuth": { functionsFetch: async (url, options) => {
      calls.push({ service: "functions", url, options });
      return new Response(null, { status });
    } },
    "@/lib/appInsights": { trackError: (...args) => errors.push(args) },
  };
  const source = ts.transpileModule(
    await readFile(new URL("../../app/src/hooks/useAddresses.ts", import.meta.url), "utf8"),
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
  return { hook: module.namespace.useAddresses(), calls, errors };
}

test("address removal uses the owner-bound Function before refreshing DAB reads", async () => {
  const { hook, calls, errors } = await loadAddresses();
  await hook.deleteAddress("101");
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].service, "functions");
  assert.equal(calls[0].url, "https://functions.example.test/api/addresses/101");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[1].service, "dab");
  assert.equal(calls[1].options, undefined);
});

test("denied address removal is surfaced and never deletes links or refreshes", async () => {
  const { hook, calls, errors } = await loadAddresses({ status: 403 });
  await assert.rejects(() => hook.deleteAddress("102"), /HTTP 403/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "functions");
  assert.equal(errors.length, 1);
});

test("shared-address edits surface the conflict without changing type or refreshing", async () => {
  const { hook, calls, errors } = await loadAddresses({ status: 409 });
  await assert.rejects(() => hook.updateAddress("101", { city: "New city", isDefault: true }),
    error => error.name === "SharedAddressError");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "functions");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(errors.length, 1);
});

test("unsigned callers do not request address removal", async () => {
  const { hook, calls } = await loadAddresses({ user: null });
  await hook.deleteAddress("101");
  assert.equal(calls.length, 0);
});
