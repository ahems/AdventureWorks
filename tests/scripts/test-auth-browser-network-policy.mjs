import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { confirmedConsumerCleanupItem, dabBrowserReadPolicy, functionsBrowserRequest, guardStorefrontBrowserRequest,
  oauthBrowserRequest } from "./auth-browser-network-policy.mjs";

const config = JSON.parse(await readFile(new URL("../../api/dab-config.json", import.meta.url), "utf8"));
const dab = dabBrowserReadPolicy(config);
const request = (method, path, headers = {}, body = null, hasBody = body !== null) =>
  ({ method, url: new URL(path, "https://example.invalid"), headers, body, hasBody });
const guest = { cartId: "guest-" + "a".repeat(32), token: "private-proof" };
const fixture = { guest, consumerIds: ["7", "8"], bootstrapRequested: false,
  added: false, merged: false, productId: 31 };
const guestHeaders = { "x-guest-cart-session": guest.token };
const consumerHeaders = { authorization: "Bearer private-token" };

test("DAB browser guard admits only reviewed read operations", () => {
  assert.equal(dab(request("GET", "/api/Product?$first=1")), true);
  assert.equal(dab(request("POST", "/graphql", {}, { query: "query { products { items { ProductID } } }" })), true);
  assert.equal(dab(request("OPTIONS", "/graphql", { "access-control-request-method": "POST" })), true);
  for (const denied of [
    request("GET", "/api/Unknown"), request("GET", "/graphql?query=mutation"),
    request("POST", "/api/Product", {}, {}), request("DELETE", "/api/Product/ProductID/1"),
    request("POST", "/graphql", {}, { query: "mutation { deleteProduct(ProductID: 1) { ProductID } }" }),
    request("POST", "/graphql", {}, { query: "{ products { items { ProductID } } } mutation M { x }" }),
    request("OPTIONS", "/api/Product", { "access-control-request-method": "DELETE" }),
  ]) assert.equal(dab(denied), false);
  const unreviewed = structuredClone(config);
  unreviewed.entities.Product.source.type = "stored-procedure";
  assert.throws(() => dabBrowserReadPolicy(unreviewed), /reviewed table\/view/);
});

test("Functions browser guard denies unreviewed reads and former state-changing GET routes", () => {
  assert.equal(functionsBrowserRequest(request("GET", "/api/webpubsub/negotiate")), true);
  for (const path of ["/api/manufacturing/status", "/api/archive/trigger",
    "/api/orders/delivery/trigger", "/api/unknown"]) {
    assert.equal(functionsBrowserRequest(request("GET", path)), false);
    assert.equal(functionsBrowserRequest(request("OPTIONS", path,
      { "access-control-request-method": "GET" })), false);
  }
  assert.equal(functionsBrowserRequest(request("POST", "/api/webpubsub/negotiate")), false);
});

test("storefront browser permits only its authenticated payment-method read", () => {
  const paymentRead = request("GET", "/api/payment-methods", consumerHeaders);
  assert.equal(functionsBrowserRequest(paymentRead, fixture), true);
  assert.equal(functionsBrowserRequest(request("OPTIONS", "/api/payment-methods",
    { "access-control-request-method": "GET" }), fixture), true);
  for (const denied of [
    request("GET", "/api/payment-methods"),
    request("GET", "/api/payment-methods?person=8", consumerHeaders),
    request("GET", "/api/payment-methods/1", consumerHeaders),
    request("POST", "/api/payment-methods", consumerHeaders),
    request("OPTIONS", "/api/payment-methods", { "access-control-request-method": "POST" }),
  ]) assert.equal(functionsBrowserRequest(denied, fixture), false);
  assert.equal(functionsBrowserRequest(paymentRead), false);
  assert.equal(functionsBrowserRequest(paymentRead, { ...fixture, consumerIds: [] }), false);
});

test("storefront browser permits only its bounded run-owned cart operations", () => {
  const session = request("POST", "/api/cart/session");
  const add = request("POST", `/api/cart/items?cartId=${guest.cartId}`, guestHeaders,
    { ProductID: 31, Quantity: 1 });
  const merge = request("POST", "/api/cart/merge?cartId=7", { ...guestHeaders, ...consumerHeaders });
  assert.equal(functionsBrowserRequest(session, fixture), true);
  assert.equal(functionsBrowserRequest(add, fixture), true);
  assert.equal(functionsBrowserRequest(merge, fixture), true);
  assert.equal(functionsBrowserRequest(request("GET", `/api/cart/items?cartId=${guest.cartId}`, guestHeaders),
    fixture), true);
  assert.equal(functionsBrowserRequest(request("GET", "/api/cart/items?cartId=8", consumerHeaders), fixture), true);
  assert.equal(functionsBrowserRequest(session, { ...fixture, bootstrapRequested: true }), false);
  assert.equal(functionsBrowserRequest(add, { ...fixture, added: true }), false);
  assert.equal(functionsBrowserRequest(merge, { ...fixture, merged: true }), false);
  for (const denied of [
    request("POST", `/api/cart/items?cartId=${guest.cartId}`, guestHeaders, { ProductID: 32, Quantity: 1 }),
    request("POST", `/api/cart/items?cartId=${guest.cartId}`, guestHeaders, { ProductID: 31, Quantity: 2 }),
    request("POST", `/api/cart/items?cartId=${guest.cartId}`, { ...guestHeaders, ...consumerHeaders },
      { ProductID: 31, Quantity: 1 }),
    request("POST", "/api/cart/items?cartId=7", guestHeaders, { ProductID: 31, Quantity: 1 }),
    request("POST", "/api/cart/merge?cartId=8", { ...guestHeaders, ...consumerHeaders }),
    request("POST", "/api/cart/merge?cartId=7&cartId=8", { ...guestHeaders, ...consumerHeaders }),
    request("POST", "/api/cart/session", {}, null, true),
    request("POST", "/api/cart/merge?cartId=7", { ...guestHeaders, ...consumerHeaders }, null, true),
    request("DELETE", "/api/cart/items?cartId=7", consumerHeaders),
    request("DELETE", "/api/cart/session", guestHeaders),
    request("PATCH", "/api/cart/items/1?cartId=7", consumerHeaders, { Quantity: 2 }),
  ]) assert.equal(functionsBrowserRequest(denied, fixture), false);
});

test("consumer cleanup admits only one confirmed item and preserves the exact baseline", () => {
  const old = { ShoppingCartItemID: 1, ShoppingCartID: "7", ProductID: 20, Quantity: 2 };
  const added = { ShoppingCartItemID: 2, ShoppingCartID: "7", ProductID: 31, Quantity: 1 };
  assert.equal(confirmedConsumerCleanupItem([old], [old], 31, undefined), null);
  assert.equal(confirmedConsumerCleanupItem([old], [old, added], 31, 2), 2);
  for (const [baseline, current, id] of [
    [[old], [old, added], undefined],
    [[old], [old, added], 3],
    [[old], [old, { ...added, Quantity: 2 }], 2],
    [[old], [{ ...old, Quantity: 3 }, added], 2],
    [[old], [old, added, { ...added, ShoppingCartItemID: 3 }], 2],
    [[old, added], [old, { ...added, Quantity: 2 }], 2],
  ]) assert.throws(() => confirmedConsumerCleanupItem(baseline, current, 31, id), /confirmed run-owned/);
});

test("browser OAuth guard excludes other MCP operations", () => {
  assert.equal(oauthBrowserRequest(request("GET", "/authorize")), true);
  assert.equal(oauthBrowserRequest(request("POST", "/token")), true);
  assert.equal(oauthBrowserRequest(request("OPTIONS", "/token",
    { "access-control-request-method": "POST" })), true);
  for (const denied of [request("GET", "/mcp"), request("POST", "/mcp"),
    request("POST", "/unknown"), request("GET", "/logout")]) {
    assert.equal(oauthBrowserRequest(denied), false);
  }
});

test("guest bootstrap is captured before delivery and never retried", async () => {
  const events = [], session = { cartId: guest.cartId, token: "a".repeat(64), expiresAt: "2030-01-01T00:00:00Z" };
  const state = {
    functionsOrigin: "https://functions.example.invalid", dabOrigin: "https://dab.example.invalid",
    mcpOrigin: "https://mcp.example.invalid", allowedTokenOrigins: new Set(), allowsDabRead: dab,
    consumerIds: ["7", "8"], guest: null, bootstrapRequested: false, added: false, merged: false,
    productId: null, blockedRequests: [], guardErrors: [],
    onBootstrapStarted: async () => events.push("started"),
    onBootstrapCaptured: async value => { assert.deepEqual(value, session); events.push("captured"); },
  };
  const route = {
    request: () => ({ url: () => state.functionsOrigin + "/api/cart/session", method: () => "POST",
      headers: () => ({}), postData: () => null, postDataJSON: () => null }),
    fetch: async options => {
      assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 20000 });
      events.push("fetch");
      return { status: () => 200, json: async () => session };
    },
    fulfill: async () => events.push("fulfilled"),
    abort: async () => events.push("aborted"),
  };
  await guardStorefrontBrowserRequest(route, state);
  assert.deepEqual(events, ["started", "fetch", "captured", "fulfilled"]);
  assert.deepEqual(state.guest, session);
  await guardStorefrontBrowserRequest(route, state);
  assert.deepEqual(events, ["started", "fetch", "captured", "fulfilled", "aborted"]);
  assert.equal(state.blockedRequests.length, 1);
});

test("browser route errors are contained and recorded without request details", async () => {
  const state = {
    functionsOrigin: "https://functions.example.invalid", dabOrigin: "https://dab.example.invalid",
    mcpOrigin: "https://mcp.example.invalid", allowedTokenOrigins: new Set(), allowsDabRead: dab,
    consumerIds: [], guest: null, bootstrapRequested: false, added: false, merged: false, productId: null,
    blockedRequests: [], guardErrors: [], onBootstrapStarted: async () => {},
    onBootstrapCaptured: async () => {},
  };
  let aborted = 0;
  const route = {
    request: () => ({ url: () => state.functionsOrigin + "/api/cart/session", method: () => "POST",
      headers: () => ({}), postData: () => null, postDataJSON: () => null }),
    fetch: async () => { throw new Error("private response"); },
    abort: async () => { aborted++; },
  };
  await guardStorefrontBrowserRequest(route, state);
  assert.equal(aborted, 1);
  assert.equal(state.bootstrapRequested, true);
  assert.deepEqual(state.guardErrors, [{ stage: "intercept", type: "Error" }]);
  assert.equal(JSON.stringify(state.guardErrors).includes("private response"), false);
});
