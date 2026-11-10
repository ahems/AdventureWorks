import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const result = { checks: [], cart: null };
const consumer = process.env.AUTH_BROWSER_CONSUMER_ID;
let browser, page, guestSession, baseline, productId, phase = "browser-configuration";
const functionsUrl = (route) => new URL("/api/cart" + route, process.env.API_FUNCTIONS_URL);
const request = async (url, options = {}) => fetch(url, {
  ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
});
const accountRows = async () => {
  const url = functionsUrl("/items");
  url.searchParams.set("cartId", consumer);
  const response = await request(url, { headers: {
    Authorization: "Bearer " + process.env.AUTH_BROWSER_CONSUMER_TOKEN,
  } });
  assert.equal(response.status, 200, "Consumer fixture read must succeed");
  const rows = await response.json();
  assert.ok(Array.isArray(rows) && rows.every((row) => row && row.ShoppingCartID === consumer &&
    Number.isInteger(row.ShoppingCartItemID) && Number.isInteger(row.ProductID) &&
    Number.isInteger(row.Quantity)), "Consumer snapshot must contain exclusively owned rows");
  return rows.sort((a, b) => a.ShoppingCartItemID - b.ShoppingCartItemID);
};
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
  for (const url of [site, functions])
    assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash);
  if (consumer) {
    assert.ok(/^[1-9]\d*$/.test(consumer) && process.env.AUTH_BROWSER_CONSUMER_EMAIL &&
      process.env.AUTH_BROWSER_CONSUMER_PASSWORD && process.env.AUTH_BROWSER_CONSUMER_TOKEN);
    phase = "consumer-baseline";
    baseline = await accountRows();
    result.consumer = { businessEntityId: Number(consumer), mutationPossible: false };
    await save();
  }
  phase = "browser-prerequisites";
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });
  const blocked = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === functions.origin && url.pathname === "/api/cart/session" && request.method() === "POST") {
      result.bootstrapRequested = true;
      await save();
    }
    if (url.origin === functions.origin && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
        !url.pathname.startsWith("/api/cart/")) {
      blocked.push(url.pathname);
      await route.abort();
    } else await route.continue();
  });
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
  guestSession = initial.session;
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
    check("consumer-auto-merge", owned.status === 200 && Array.isArray(owned.rows) &&
      owned.rows.length === baseline.length + 1 &&
      owned.rows.every((row) => row.ShoppingCartID === consumer) &&
      owned.rows.filter((row) => row.ProductID === productId && row.Quantity === 1).length === 1);
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
  }
  check("no-non-cart-function-mutations", blocked.length === 0);
} catch (error) {
  result.checks.push({ name: phase, status: phase === "browser-prerequisites" ? "BLOCKED" : "FAIL",
    errorType: error.name });
} finally {
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
      for (const row of (await accountRows()).filter((item) => item.ProductID === productId)) {
        const url = functionsUrl("/items/" + row.ShoppingCartItemID);
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
  if (browser) await browser.close();
  await save();
  console.log(JSON.stringify({ checks: result.checks }));
  process.exitCode = result.checks.some((item) => item.status !== "PASS") ? 1 : 0;
}
