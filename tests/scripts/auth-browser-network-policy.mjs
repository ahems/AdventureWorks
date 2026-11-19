function requestIntent(request) {
  if (request.method !== "OPTIONS") return { method: request.method, preflight: false };
  const requested = request.headers["access-control-request-method"];
  return typeof requested === "string" && /^[A-Za-z]+$/.test(requested)
    ? { method: requested.toUpperCase(), preflight: true }
    : null;
}

export async function newAuthBrowserPage(context) {
  const page = await context.newPage();
  // Keep the page interceptor installed while temporary routes are removed.
  await page.route("**/*", route => route.fallback());
  return page;
}

export function cartSignature(rows) {
  return JSON.stringify(rows.map(row =>
    [row.ShoppingCartItemID, row.ShoppingCartID, row.ProductID, row.Quantity])
    .sort((left, right) => left[0] - right[0]));
}

export function confirmedConsumerCleanupItem(baseline, current, productId, confirmedItemId) {
  if (cartSignature(current) === cartSignature(baseline)) return null;
  const added = current.filter(row => row.ShoppingCartItemID === confirmedItemId);
  if (!Number.isSafeInteger(confirmedItemId) || confirmedItemId <= 0 ||
      baseline.some(row => row.ShoppingCartItemID === confirmedItemId) ||
      added.length !== 1 || added[0].ProductID !== productId || added[0].Quantity !== 1 ||
      cartSignature(current.filter(row => row.ShoppingCartItemID !== confirmedItemId)) !== cartSignature(baseline)) {
    throw new Error("Consumer fixture differs from the confirmed run-owned cart item");
  }
  return confirmedItemId;
}

export function dabBrowserReadPolicy(config) {
  const entries = Object.entries(config?.entities ?? {});
  const rest = config?.runtime?.rest?.path;
  const graphql = config?.runtime?.graphql?.path;
  if (!entries.length || rest !== "/api" || graphql !== "/graphql" ||
      entries.some(([name, entity]) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
        !entity || entity.rest !== undefined || !["table", "view"].includes(entity.source?.type))) {
    throw new Error("DAB browser read policy requires reviewed table/view bindings");
  }
  const entities = new Set(entries.map(([name]) => name));
  return request => {
    const intent = requestIntent(request);
    if (!intent) return false;
    const { method, preflight } = intent;
    const path = request.url.pathname;
    if (["GET", "HEAD"].includes(method)) {
      const parts = path.split("/");
      return parts[1] === "api" && entities.has(parts[2]);
    }
    if (method !== "POST" || !/^\/graphql\/?$/.test(path)) return false;
    if (preflight) return true;
    const query = request.body?.query;
    return typeof query === "string" && /^\s*(query\b|\{)/.test(query) &&
      !/\bmutation\b/.test(query);
  };
}

export function oauthBrowserRequest(request) {
  const intent = requestIntent(request);
  if (!intent) return false;
  const { method } = intent;
  const path = request.url.pathname;
  return ["GET", "HEAD"].includes(method) &&
    ["/authorize", "/login", "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server"].includes(path) ||
    method === "POST" && ["/login", "/token"].includes(path);
}

export function functionsBrowserRequest(request, fixture = null) {
  const intent = requestIntent(request);
  if (!intent) return false;
  const { method, preflight } = intent;
  const { url, headers, body } = request;
  if (method === "GET" && url.pathname === "/api/webpubsub/negotiate") return true;
  if (!fixture) return false;
  if (method === "GET" && url.pathname === "/api/payment-methods" && !url.search) {
    return fixture.consumerIds.length > 0 && (preflight || /^Bearer \S+$/i.test(headers.authorization ?? ""));
  }

  if (method === "POST" && url.pathname === "/api/cart/session") {
    return !fixture.bootstrapRequested && !url.search && (preflight || !request.hasBody);
  }
  if (!["/api/cart/items", "/api/cart/merge"].includes(url.pathname) ||
      [...url.searchParams.keys()].some(key => key !== "cartId") ||
      url.searchParams.getAll("cartId").length !== 1) return false;
  const cartId = url.searchParams.get("cartId");
  const guest = fixture.guest;
  const ownGuest = guest && typeof guest.token === "string" && guest.token.length > 0 &&
    /^guest-[0-9a-f]{32}$/.test(guest.cartId) && cartId === guest.cartId;
  const guestProof = ownGuest && headers["x-guest-cart-session"] === guest.token;
  const bearer = /^Bearer \S+$/i.test(headers.authorization ?? "");
  const ownConsumer = fixture.consumerIds.includes(cartId);
  if (method === "GET" && url.pathname === "/api/cart/items") {
    return preflight ? Boolean(ownGuest || ownConsumer) :
      Boolean(ownGuest && (guestProof || bearer) || ownConsumer && bearer);
  }
  if (method === "POST" && url.pathname === "/api/cart/items" && !fixture.added && ownGuest) {
    return preflight || Boolean(guestProof && !bearer && body && typeof body === "object" &&
      !Array.isArray(body) && Object.keys(body).sort().join(",") === "ProductID,Quantity" &&
      Number.isSafeInteger(body.ProductID) && body.ProductID > 0 &&
      (fixture.productId === null || body.ProductID === fixture.productId) && body.Quantity === 1);
  }
  if (method === "POST" && url.pathname === "/api/cart/merge" && !fixture.merged &&
      cartId === fixture.consumerIds[0] && guest && typeof guest.token === "string") {
    return preflight || Boolean(bearer && headers["x-guest-cart-session"] === guest.token && !request.hasBody);
  }
  return false;
}

export async function guardStorefrontBrowserRequest(route, state) {
  const recordError = (stage, error) => state.guardErrors.push({
    stage,
    type: ["Error", "AssertionError", "SyntaxError", "TimeoutError"].includes(error?.name)
      ? error.name : "BrowserError",
  });
  try {
    const request = route.request(), url = new URL(request.url());
    const headers = request.headers();
    if (headers.authorization && !state.allowedTokenOrigins.has(url.origin) ||
        headers["x-guest-cart-session"] && url.origin !== state.functionsOrigin) {
      state.blockedRequests.push({ reason: "credential-origin", method: request.method() });
      return await route.abort();
    }
    let body = null;
    const hasBody = request.postData() !== null;
    if (request.method() === "POST" && [state.functionsOrigin, state.dabOrigin].includes(url.origin)) {
      try { body = request.postDataJSON(); } catch { body = null; }
    }
    const probe = { method: request.method(), url, headers, body, hasBody };
    const allowed = url.origin === state.dabOrigin ? state.allowsDabRead(probe) :
      url.origin === state.functionsOrigin ? functionsBrowserRequest(probe, state) :
      url.origin === state.mcpOrigin ? oauthBrowserRequest(probe) : true;
    if (!allowed) {
      state.blockedRequests.push({ reason: "unreviewed-data-plane-request", method: request.method(),
        service: url.origin === state.dabOrigin ? "dab" : url.origin === state.functionsOrigin ? "functions" : "oauth-mcp" });
      return await route.abort();
    }
    if (url.origin === state.functionsOrigin && url.pathname === "/api/cart/session" && request.method() === "POST") {
      state.bootstrapRequested = true;
      await state.onBootstrapStarted();
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 20000 });
      if (response.status() === 200) {
        const session = await response.json();
        if (!session || !/^guest-[0-9a-f]{32}$/.test(session.cartId) ||
            !/^[0-9a-f]{64}$/i.test(session.token) || !Number.isFinite(Date.parse(session.expiresAt))) {
          throw new Error("Guest bootstrap returned an invalid capability");
        }
        state.guest = session;
        await state.onBootstrapCaptured(session);
      }
      return await route.fulfill({ response });
    }
    if (url.origin === state.functionsOrigin && request.method() === "POST") {
      if (url.pathname === "/api/cart/items") state.added = true;
      if (url.pathname === "/api/cart/merge") state.merged = true;
    }
    await route.continue();
  } catch (error) {
    recordError("intercept", error);
    try { await route.abort(); }
    catch (abortError) { recordError("abort", abortError); }
  }
}
