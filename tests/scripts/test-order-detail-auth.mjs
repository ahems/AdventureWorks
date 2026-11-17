import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const ts = require("typescript");
const { z } = require("zod");

async function load(path, dependencies, globals = {}) {
  const source = ts.transpileModule(
    await readFile(new URL(path, import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const module = new vm.SourceTextModule(source, { context: vm.createContext(globals) });
  await module.link(async name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const values = dependencies[name];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context: module.context });
  });
  await module.evaluate();
  return module.namespace;
}

const fixture = {
  salesOrderId: 123, productId: 5, orderQty: 2, unitPrice: 10.25,
  unitPriceDiscount: 0.1, lineTotal: 18.45, productName: "Fixture product",
};

function isOwnedHeaderPost(node, file) {
  if (!ts.isCallExpression(node) || node.expression.getText(file) !== "functionsFetch" ||
      !node.arguments[0] || !ts.isTemplateExpression(node.arguments[0]) ||
      !node.arguments[1] || !ts.isObjectLiteralExpression(node.arguments[1])) return false;
  const url = node.arguments[0];
  const post = node.arguments[1].properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText(file) === "method" &&
    ts.isStringLiteral(property.initializer) && property.initializer.text === "POST");
  return post && url.head.text === "" && url.templateSpans.length === 1 &&
    url.templateSpans[0].expression.getText(file) === "getFunctionsApiUrl()" &&
    url.templateSpans[0].literal.text === "/api/orders";
}

async function orderDetails({ body = [fixture], status = 200 } = {}) {
  const calls = [];
  const module = await load("../../app/src/services/orderDetails.ts", {
    zod: { z },
    "@/lib/utils": { getFunctionsApiUrl: () => "https://functions.example.test" },
    "@/services/functionsAuth": { functionsFetch: async url => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status });
    } },
  }, { URLSearchParams });
  return { fetchDetails: module.fetchOwnedOrderDetails, calls };
}

test("order details use one authenticated Functions batch and validate its exact shape", async () => {
  const { fetchDetails, calls } = await orderDetails();
  const result = await fetchDetails([123, 124]);
  assert.equal(result.length, 1);
  assert.equal(result[0].productName, "Fixture product");
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/api/orders/details");
  assert.equal(url.searchParams.get("orderIds"), "123,124");
});

test("empty or invalid batches never trigger a request; 100 IDs remain supported", async () => {
  const { fetchDetails, calls } = await orderDetails({ body: [] });
  assert.equal((await fetchDetails([])).length, 0);
  for (const ids of [[0], [-1], [1, 1], [1.5], [2147483648], Array.from({ length: 101 }, (_, i) => i + 1)]) {
    await assert.rejects(() => fetchDetails(ids));
  }
  assert.equal(calls.length, 0);
  await fetchDetails(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(calls.length, 1);
});

test("HTTP errors, foreign-order rows, and unexpected response fields fail visibly", async () => {
  for (const options of [
    { status: 403 },
    { body: [{ ...fixture, salesOrderId: 456 }] },
    { body: [{ ...fixture, privateValue: "unexpected" }] },
    { body: {} },
  ]) {
    const { fetchDetails } = await orderDetails(options);
    await assert.rejects(() => fetchDetails([123]));
  }
});

test("order history combines owned headers with the Functions batch, not nested DAB details", async () => {
  let query = "";
  const batches = [];
  const module = await load("../../app/src/hooks/useOrders.ts", {
    "@tanstack/react-query": { useQuery: options => options },
    "@/lib/graphql-client": { graphqlClient: { request: async () => ({
      salesOrderHeaders: { items: [{ SalesOrderID: 123 }, { SalesOrderID: 124 }] },
    }) } },
    "graphql-request": { gql: strings => { query = strings.join(""); return query; } },
    "@/services/orderDetails": { fetchOwnedOrderDetails: async ids => {
      batches.push([...ids]);
      return [fixture];
    } },
  });
  const options = module.useOrders(7);
  const result = await options.queryFn();
  assert.deepEqual(batches, [[123, 124]]);
  assert.equal(query.includes("salesOrderDetails"), false);
  assert.equal(result[0].salesOrderDetails.items[0].product.Name, "Fixture product");
  assert.equal(result[0].salesOrderDetails.items[0].LineTotal, 18.45);
  assert.equal(result[1].salesOrderDetails.items.length, 0);
});

test("checkout preserves protected product fields and clears the cart through its owner-bound path", async () => {
  const source = await readFile(new URL("../../app/src/pages/CheckoutPage.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("CheckoutPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const queries = [];
  let awaitsCartClear = false;
  let usesOwnedHeader = false;
  const visit = node => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === "gql") {
      queries.push(node.template.getText(file));
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(file) === "clearCart") awaitsCartClear = true;
    usesOwnedHeader ||= isOwnedHeaderPost(node, file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(queries.length > 0);
  assert.doesNotMatch(queries.join("\n"), /\b(createSalesOrderHeader|updateProduct|deleteShoppingCartItem|SafetyStockLevel)\b/);
  assert.equal(awaitsCartClear, true);
  assert.equal(usesOwnedHeader, true);

  const catalog = await load("../../app/src/lib/graphql-queries.ts", {
    "graphql-request": { gql: strings => strings.join("") },
  });

  const productQueries = Object.entries(catalog)
    .filter(([name]) => /^GET_PRODUCTS?(?:_BY_.*)?$/.test(name))
    .map(([, query]) => query);
  assert.ok(productQueries.length >= 6);
  assert.doesNotMatch(productQueries.join("\n"),
    /\b(StandardCost|SafetyStockLevel|ReorderPoint|DaysToManufacture)\b/);
  assert.doesNotMatch(catalog.GET_PRODUCT_INVENTORY + catalog.GET_PRODUCTS_INVENTORY, /\b(Shelf|Bin)\b/);
});

test("checkout header assertion rejects detail URLs and non-POST requests", () => {
  for (const [source, expected] of [
    ['functionsFetch(`${getFunctionsApiUrl()}/api/orders`, { method: "POST" })', true],
    ['functionsFetch(`${getFunctionsApiUrl()}/api/orders`, { method: "GET" })', false],
    ['functionsFetch(`${getFunctionsApiUrl()}/api/orders/7/details`, { method: "POST" })', false],
  ]) {
    const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
    assert.equal(isOwnedHeaderPost(file.statements[0].expression, file), expected);
  }
});
