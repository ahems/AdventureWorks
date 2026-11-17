import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { cartSignature, confirmedConsumerCleanupItem, dabBrowserReadPolicy,
  guardStorefrontBrowserRequest } from "./auth-browser-network-policy.mjs";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const result = { checks: [], cart: null, blockedRequests: [], guardErrors: [] };
const consumer = process.env.AUTH_BROWSER_CONSUMER_ID;
const otherConsumer = process.env.AUTH_BROWSER_CONSUMER_B_ID;
let browser, page, secondPage, guestSession, baseline, otherBaseline, productId, confirmedItemId,
  phase = "browser-configuration";
const functionsUrl = (route) => new URL("/api/cart" + route, process.env.API_FUNCTIONS_URL);
const request = async (url, options = {}) => fetch(url, {
  ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
});
const accountRowsFor = async (owner, token) => {
  const url = functionsUrl("/items");
  url.searchParams.set("cartId", owner);
  const response = await request(url, { headers: {
    Authorization: "Bearer " + token,
  } });
  assert.equal(response.status, 200, "Consumer fixture read must succeed");
  const rows = await response.json();
  assert.ok(Array.isArray(rows) && rows.every((row) => row && row.ShoppingCartID === owner &&
    Number.isInteger(row.ShoppingCartItemID) && Number.isInteger(row.ProductID) &&
    Number.isInteger(row.Quantity)), "Consumer snapshot must contain exclusively owned rows");
  return rows.sort((a, b) => a.ShoppingCartItemID - b.ShoppingCartItemID);
};
const accountRows = () => accountRowsFor(consumer, process.env.AUTH_BROWSER_CONSUMER_TOKEN);
const save = async () => {
  if (!output) return;
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
};
const check = (name, condition) => {
  result.checks.push({ name, status: condition ? "PASS" : "FAIL" });
  assert.ok(condition, name);
};

try {
  const site = new URL(process.env.AUTH_BROWSER_SITE_URL);
  const functions = new URL(process.env.API_FUNCTIONS_URL);
  const dab = new URL(process.env.API_URL);
  const mcp = new URL(process.env.API_MCP_URL);
  for (const url of [site, functions, dab, mcp])
    assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash);
  assert.equal(new Set([functions.origin, dab.origin, mcp.origin]).size, 3);
  const allowsDabRead = dabBrowserReadPolicy(
    JSON.parse(await readFile(new URL("../../api/dab-config.json", import.meta.url), "utf8")));
  const allowedTokenOrigins = new Set([functions.origin, dab.origin, mcp.origin]);
  if (consumer) {
    assert.ok(/^[1-9]\d*$/.test(consumer) && process.env.AUTH_BROWSER_CONSUMER_EMAIL &&
      process.env.AUTH_BROWSER_CONSUMER_PASSWORD && process.env.AUTH_BROWSER_CONSUMER_TOKEN);
    if (otherConsumer) {
      assert.ok(/^[1-9]\d*$/.test(otherConsumer) && otherConsumer !== consumer &&
        process.env.AUTH_BROWSER_CONSUMER_B_EMAIL && process.env.AUTH_BROWSER_CONSUMER_B_PASSWORD &&
        process.env.AUTH_BROWSER_CONSUMER_B_TOKEN);
    }
    phase = "consumer-baseline";
    baseline = await accountRows();
    if (otherConsumer) {
      otherBaseline = await accountRowsFor(otherConsumer, process.env.AUTH_BROWSER_CONSUMER_B_TOKEN);
      result.consumerAccountSwitch = true;
    }
    result.consumer = { businessEntityId: Number(consumer), mutationPossible: false };
    await save();
  }
  phase = "browser-prerequisites";
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });
  const guard = {
    dabOrigin: dab.origin, functionsOrigin: functions.origin, mcpOrigin: mcp.origin,
    allowedTokenOrigins, allowsDabRead, consumerIds: [consumer, otherConsumer].filter(Boolean),
    guest: null, bootstrapRequested: false, added: false, merged: false, productId: null,
    blockedRequests: result.blockedRequests, guardErrors: result.guardErrors,
    onBootstrapStarted: async () => { result.bootstrapRequested = true; await save(); },
    onBootstrapCaptured: async session => {
      guestSession = session;
      result.cart = { cartId: session.cartId, expiresAt: session.expiresAt };
      await save();
    },
  };
  await context.route("**/*", route => guardStorefrontBrowserRequest(route, guard));
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  phase = "guest-add";
  await page.goto(site.toString(), { waitUntil: "domcontentloaded" });
  const enabledAdd = page.getByRole("button", { name: /^add to cart$/i }).and(page.locator("button:enabled"));
  await enabledAdd.first().waitFor();
  if (consumer) {
    const candidates = await enabledAdd.evaluateAll((buttons, used) =>
      buttons.map((button) => button.closest("a")?.getAttribute("href")?.match(/^\/product\/(\d+)$/)?.[1])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0 && !used.includes(id)),
    baseline.map((row) => row.ProductID));
    assert.ok(candidates.length, "A displayed product absent from the fixture cart is required");
    productId = candidates[0];
    guard.productId = productId;
    result.consumer.productId = productId;
  }
  result.mutationAttempted = true;
  await save();
  await (consumer ? page.locator(`a[href="/product/${productId}"]`)
    .getByRole("button", { name: /^add to cart$/i }).and(page.locator("button:enabled")).first()
    : enabledAdd.first()).click();
  await page.waitForFunction(() => localStorage.getItem("adventureworks_guest_cart") !== null);
  await page.getByText("Added to Cart!", { exact: true }).waitFor();
  const initial = await page.evaluate(async (base) => {
    const session = JSON.parse(localStorage.getItem("adventureworks_guest_cart"));
    const url = new URL("/api/cart/items", base);
    url.searchParams.set("cartId", session.cartId);
    const response = await fetch(url, { headers: { "X-Guest-Cart-Session": session.token },
      signal: AbortSignal.timeout(20000) });
    const items = await response.json();
    return { status: response.status, session, cartId: session.cartId, expiresAt: session.expiresAt,
      productId: Array.isArray(items) && items.length === 1 ? items[0].ProductID : null,
      count: Array.isArray(items) ? items.length : -1,
      total: Array.isArray(items) ? items.reduce((sum, item) => sum + item.Quantity, 0) : -1,
      owned: Array.isArray(items) && items.every((item) => item.ShoppingCartID === session.cartId) };
  }, functions.toString());
  assert.equal(initial.session?.cartId, guestSession?.cartId, "Guest cart must match the captured bootstrap");
  assert.equal(initial.session?.token, guestSession?.token, "Guest proof must match the captured bootstrap");
  result.cart = { cartId: initial.cartId, expiresAt: initial.expiresAt };
  await save();
  check("guest-add-persists", initial.status === 200 && initial.count === 1 && initial.total === 1 && initial.owned);
  if (consumer) assert.equal(initial.productId, productId, "Only the isolated displayed product was added");
  phase = "guest-cart-reload";
  await page.goto(new URL("/cart", site).toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Remove item", exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Remove item", exact: true }).waitFor();
  check("guest-cart-survives-reload", true);
  phase = "checkout-guard";
  await page.goto(new URL("/checkout", site).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.origin === site.origin && url.pathname === "/auth");
  check("checkout-requires-signin", true);
  if (consumer) {
    phase = "consumer-signin";
    // A hard navigation clears the checkout return state; no order initialization is permitted.
    await page.goto(new URL("/auth", site).toString(), { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(process.env.AUTH_BROWSER_CONSUMER_EMAIL);
    await page.locator("#password").fill(process.env.AUTH_BROWSER_CONSUMER_PASSWORD);
    result.consumer.mutationPossible = true;
    await save();
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForFunction(() => localStorage.getItem("adventureworks_guest_cart") === null &&
      sessionStorage.getItem("functions_oauth_token") !== null);
    phase = "consumer-auto-merge";
    const owned = await page.evaluate(async ({ base, owner }) => {
      const token = JSON.parse(sessionStorage.getItem("functions_oauth_token")).accessToken;
      const url = new URL("/api/cart/items", base);
      url.searchParams.set("cartId", owner);
      const response = await fetch(url, { headers: { Authorization: "Bearer " + token },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
      return { status: response.status, rows: await response.json() };
    }, { base: functions.toString(), owner: consumer });
    const addedRows = Array.isArray(owned.rows) ? owned.rows.filter((row) =>
      row.ProductID === productId && row.Quantity === 1) : [];
    check("consumer-auto-merge", owned.status === 200 && Array.isArray(owned.rows) &&
      owned.rows.length === baseline.length + 1 &&
      owned.rows.every((row) => row.ShoppingCartID === consumer) &&
      addedRows.length === 1 && Number.isSafeInteger(addedRows[0].ShoppingCartItemID) &&
      addedRows[0].ShoppingCartItemID > 0 &&
      !baseline.some((row) => row.ShoppingCartItemID === addedRows[0].ShoppingCartItemID) &&
      cartSignature(owned.rows.filter((row) => row.ShoppingCartItemID !== addedRows[0].ShoppingCartItemID)) ===
        cartSignature(baseline));
    confirmedItemId = addedRows[0].ShoppingCartItemID;
    result.consumer.confirmedItemId = confirmedItemId;
    await save();
    const denied = await request(functionsUrl("/items"), { headers: {
      "X-Guest-Cart-Session": guestSession.token,
    } });
    check("merged-guest-proof-denied", denied.status === 401);
    phase = "consumer-cart-reload";
    await page.goto(new URL("/cart", site).toString(), { waitUntil: "domcontentloaded" });
    await page.getByTestId(`cart-item-${productId}`).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId(`cart-item-${productId}`).waitFor();
    const reloaded = await accountRows();
    check("consumer-cart-reload", reloaded.some((row) => row.ProductID === productId && row.Quantity === 1) &&
      await page.evaluate(() => localStorage.getItem("adventureworks_guest_cart") === null));
    if (otherConsumer) {
      phase = "consumer-new-tab-session";
      secondPage = await context.newPage();
      await secondPage.goto(new URL("/account", site).toString(), { waitUntil: "domcontentloaded" });
      await secondPage.waitForURL((url) => url.origin === site.origin && url.pathname === "/auth");
      const tabState = await secondPage.evaluate(() => ({
        user: sessionStorage.getItem("adventureworks_current_user"),
        tokens: ["dab_oauth_token", "functions_oauth_token", "mcp_oauth_token", "eshop_oauth_refresh_token"]
          .some((key) => sessionStorage.getItem(key) !== null),
      }));
      const activeState = await page.evaluate(() => ({
        user: JSON.parse(sessionStorage.getItem("adventureworks_current_user") || "null"),
        token: JSON.parse(sessionStorage.getItem("functions_oauth_token") || "null"),
      }));
      check("consumer-new-tab-does-not-inherit-session",
        tabState.user === null && !tabState.tokens &&
        activeState.user?.businessEntityId === Number(consumer) &&
        typeof activeState.token?.accessToken === "string");
      await secondPage.close();
      secondPage = null;

      phase = "consumer-account-switch-logout";
      await page.goto(site.toString(), { waitUntil: "domcontentloaded" });
      const firstName = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("adventureworks_current_user")).firstName);
      await page.locator("header").getByRole("button").filter({ hasText: firstName }).first().click();
      await page.getByRole("button", { name: /sign out/i }).click();
      await page.waitForFunction(() => !sessionStorage.getItem("adventureworks_current_user") &&
        ["dab_oauth_token", "functions_oauth_token", "mcp_oauth_token", "eshop_oauth_refresh_token"]
          .every((key) => !sessionStorage.getItem(key)));
      check("consumer-account-switch-logout-clears-session", true);

      phase = "consumer-account-switch-signin";
      await page.goto(new URL("/auth", site).toString(), { waitUntil: "domcontentloaded" });
      await page.locator("#email").fill(process.env.AUTH_BROWSER_CONSUMER_B_EMAIL);
      await page.locator("#password").fill(process.env.AUTH_BROWSER_CONSUMER_B_PASSWORD);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForFunction((owner) => {
        const current = JSON.parse(sessionStorage.getItem("adventureworks_current_user") || "null");
        const stored = JSON.parse(sessionStorage.getItem("functions_oauth_token") || "null");
        if (current?.businessEntityId !== Number(owner) || typeof stored?.accessToken !== "string") return false;
        const payload = stored.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
        return Number(claims.business_entity_id) === Number(owner);
      }, otherConsumer);
      const switched = await page.evaluate(async ({ base, owner }) => {
        const stored = JSON.parse(sessionStorage.getItem("functions_oauth_token"));
        const payload = stored.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
        const url = new URL("/api/cart/items", base);
        url.searchParams.set("cartId", owner);
        const response = await fetch(url, { headers: { Authorization: "Bearer " + stored.accessToken },
          redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
        return { status: response.status, ownerClaim: Number(claims.business_entity_id), rows: await response.json() };
      }, { base: functions.toString(), owner: otherConsumer });
      check("consumer-account-switch-isolates-cart",
        switched.status === 200 && switched.ownerClaim === Number(otherConsumer) &&
        Array.isArray(switched.rows) && switched.rows.every((row) => row.ShoppingCartID === otherConsumer) &&
        cartSignature(switched.rows) === cartSignature(otherBaseline));
    }
  }
  check("no-non-cart-function-mutations", result.blockedRequests.length === 0 && result.guardErrors.length === 0);
} catch (error) {
  result.checks.push({ name: phase, status: phase === "browser-prerequisites" ? "BLOCKED" : "FAIL",
    errorType: error.name });
} finally {
  if (secondPage) await secondPage.close();
  if (page) {
    try {
      guestSession ??= await page.evaluate(() => JSON.parse(localStorage.getItem("adventureworks_guest_cart")));
      let cleanup = { required: result.bootstrapRequested === true, confirmed: false };
      if (guestSession) {
        const headers = { "X-Guest-Cart-Session": guestSession.token };
        let denied = await request(functionsUrl("/items"), { headers });
        if (denied.status === 200) {
          const retired = await request(functionsUrl("/session"), { method: "DELETE", headers });
          assert.ok(retired.status === 200 && (await retired.json()).retired === true);
          denied = await request(functionsUrl("/items"), { headers });
        }
        cleanup = { required: true, confirmed: denied.status === 401 };
      }
      result.checks.push({ name: "exact-browser-fixture-retired",
        status: !cleanup.required || cleanup.confirmed ? "PASS" : "FAIL" });
    } catch (error) {
      result.checks.push({ name: "exact-browser-fixture-retired", status: "FAIL", errorType: error.name });
    }
  }
  if (consumer && baseline && productId) {
    try {
      const cleanupItemId = confirmedConsumerCleanupItem(baseline, await accountRows(), productId, confirmedItemId);
      if (cleanupItemId !== null) {
        const url = functionsUrl("/items/" + cleanupItemId);
        url.searchParams.set("cartId", consumer);
        const response = await request(url, { method: "DELETE", headers: {
          Authorization: "Bearer " + process.env.AUTH_BROWSER_CONSUMER_TOKEN,
        } });
        assert.ok(response.status === 200 && (await response.json()).deleted === true);
      }
      assert.deepEqual(await accountRows(), baseline, "All pre-existing consumer rows must remain unchanged");
      result.checks.push({ name: "exact-consumer-fixture-removed", status: "PASS" });
    } catch (error) {
      result.checks.push({ name: "exact-consumer-fixture-removed", status: "FAIL", errorType: error.name });
    }
  }
  if (otherConsumer && otherBaseline) {
    try {
      assert.deepEqual(await accountRowsFor(otherConsumer, process.env.AUTH_BROWSER_CONSUMER_B_TOKEN), otherBaseline,
        "The switched-to consumer cart must remain unchanged");
      result.checks.push({ name: "exact-switched-consumer-preserved", status: "PASS" });
    } catch (error) {
      result.checks.push({ name: "exact-switched-consumer-preserved", status: "FAIL", errorType: error.name });
    }
  }
  if (browser) await browser.close();
  if (result.guardErrors.length > 0) {
    result.checks.push({ name: "browser-network-guard", status: "FAIL" });
  }
  await save();
  console.log(JSON.stringify({ checks: result.checks }));
  process.exitCode = result.checks.some((item) => item.status !== "PASS") ? 1 : 0;
}
