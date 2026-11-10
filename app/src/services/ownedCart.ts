import { getFunctionsApiUrl } from "@/lib/utils";
import { getEshopAccessToken } from "@/services/eshopOAuth";
import { trackError } from "@/lib/appInsights";
import { ShoppingCartItem } from "@/types/product";

const SESSION_KEY = "adventureworks_guest_cart";
export const GUEST_CART_STORAGE_KEY = SESSION_KEY;
export const GUEST_CART_EVENT = "adventureworks-guest-cart-changed";

export interface GuestCartSession {
  token: string;
  cartId: string;
  expiresAt: string;
}

function discardGuestSession(): void {
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(GUEST_CART_EVENT));
}

function parseGuestCartSession(raw: string): GuestCartSession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved guest cart session is invalid.");
  }
  if (!value || typeof value !== "object" || !("token" in value) ||
      !("cartId" in value) || !("expiresAt" in value) ||
      typeof value.token !== "string" || typeof value.cartId !== "string" ||
      typeof value.expiresAt !== "string" || !/^[0-9a-f]{64}$/i.test(value.token) ||
      !/^guest-[0-9a-f]{32}$/.test(value.cartId) || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error("The saved guest cart session is invalid.");
  }
  return { token: value.token, cartId: value.cartId, expiresAt: value.expiresAt };
}

export function readGuestCartSession(): GuestCartSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  let value: GuestCartSession;
  try {
    value = parseGuestCartSession(raw);
  } catch (error) {
    discardGuestSession();
    throw error;
  }
  if (Date.parse(value.expiresAt) <= Date.now()) {
    discardGuestSession();
    throw new Error("Your one-day guest cart session has expired.");
  }
  return value;
}

function forgetGuestSession(token: string): void {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return;
  let current: GuestCartSession;
  try {
    current = parseGuestCartSession(raw);
  } catch (error) {
    discardGuestSession();
    throw error;
  }
  if (current.token === token) {
    discardGuestSession();
  }
}

async function request(path: string, init: RequestInit = {}, cartId?: string,
  mergeSession?: GuestCartSession, bootstrap = false): Promise<unknown> {
  const base = new URL(getFunctionsApiUrl().replace(/\/?$/, "/"));
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" &&
       !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("The cart API must use a trusted HTTPS endpoint.");
  }
  const url = new URL("api/cart/" + path, base);
  if (cartId) url.searchParams.set("cartId", cartId);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  let guest: GuestCartSession | null = mergeSession ?? null;
  try {
    if (!bootstrap) {
      const token = await getEshopAccessToken("functions");
      if (token) headers.set("Authorization", `Bearer ${token}`);
      else if (mergeSession || (cartId && !cartId.startsWith("guest-"))) {
        throw new Error("Please sign in again to access your account cart.");
      } else {
        guest = readGuestCartSession();
        if (!guest) throw new Error("A valid guest cart session is required.");
      }
      if (guest) headers.set("X-Guest-Cart-Session", guest.token);
    }
    const response = await fetch(url.toString(), { ...init, headers, redirect: "error", cache: "no-store" });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`The cart service returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      if (response.status === 401 && guest && !mergeSession) forgetGuestSession(guest.token);
      throw new Error(`Cart request failed (HTTP ${response.status}).`);
    }
    return payload;
  } catch (error) {
    trackError("Owned cart request failed", error as Error, { operation: path });
    throw error;
  }
}

export async function ensureGuestCartSession(): Promise<GuestCartSession> {
  const stored = readGuestCartSession();
  if (stored) return stored;
  if (!navigator.locks) {
    throw new Error("Guest carts require browser Web Locks support. Please sign in instead.");
  }
  return navigator.locks.request(SESSION_KEY, async () => {
    const existing = readGuestCartSession();
    if (existing) return existing;
    const payload = await request("session", { method: "POST" }, undefined, undefined, true);
    if (!payload || typeof payload !== "object" || !("token" in payload) ||
        !("cartId" in payload) || !("expiresAt" in payload)) {
      throw new Error("The cart service returned no guest session.");
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    const session = readGuestCartSession();
    if (!session) throw new Error("The guest session could not be saved.");
    window.dispatchEvent(new Event(GUEST_CART_EVENT));
    return session;
  });
}

const merging = new Map<string, Promise<void>>();
export function mergeGuestCartSession(cartId: string, session: GuestCartSession): Promise<void> {
  const key = cartId + ":" + session.token;
  const existing = merging.get(key);
  if (existing) return existing;
  const operation = request("merge", { method: "POST" }, cartId, session).then((result) => {
    if (!result || typeof result !== "object" || !("merged" in result) || result.merged !== true)
      throw new Error("The cart service did not confirm the merge.");
    forgetGuestSession(session.token);
  }).finally(() => merging.delete(key));
  merging.set(key, operation);
  return operation;
}

function cartItem(value: unknown): ShoppingCartItem {
  if (!value || typeof value !== "object" || !("ShoppingCartItemID" in value) ||
      !("ShoppingCartID" in value) || !("ProductID" in value) || !("Quantity" in value) ||
      typeof value.ShoppingCartItemID !== "number" || !Number.isInteger(value.ShoppingCartItemID) ||
      value.ShoppingCartItemID <= 0 || typeof value.ShoppingCartID !== "string" ||
      typeof value.ProductID !== "number" || !Number.isInteger(value.ProductID) ||
      typeof value.Quantity !== "number" || !Number.isInteger(value.Quantity) || value.Quantity <= 0) {
    throw new Error("The cart service returned an invalid item.");
  }
  return { ShoppingCartItemID: value.ShoppingCartItemID, ShoppingCartID: value.ShoppingCartID,
    ProductID: value.ProductID, Quantity: value.Quantity };
}

export async function getShoppingCartItems(shoppingCartId: string, signal?: AbortSignal): Promise<ShoppingCartItem[]> {
  const value = await request("items", { signal }, shoppingCartId);
  if (!Array.isArray(value)) throw new Error("The cart service returned an invalid list.");
  return value.map(cartItem);
}

export async function createCartItem(shoppingCartId: string, productId: number, quantity: number): Promise<ShoppingCartItem> {
  return cartItem(await request("items", { method: "POST", body: JSON.stringify({ ProductID: productId, Quantity: quantity }) }, shoppingCartId));
}

export async function updateCartItemQuantity(itemId: number, quantity: number, cartId: string): Promise<ShoppingCartItem> {
  return cartItem(await request("items/" + itemId, { method: "PATCH", body: JSON.stringify({ Quantity: quantity }) }, cartId));
}

export async function deleteCartItem(itemId: number, cartId: string): Promise<boolean> {
  const result = await request("items/" + itemId, { method: "DELETE" }, cartId);
  if (!result || typeof result !== "object" || !("deleted" in result) || result.deleted !== true)
    throw new Error("The cart service did not confirm deletion.");
  return true;
}

export async function clearShoppingCart(cartId: string): Promise<boolean> {
  const result = await request("items", { method: "DELETE" }, cartId);
  if (!result || typeof result !== "object" || !("deleted" in result) || result.deleted !== true)
    throw new Error("The cart service did not confirm deletion.");
  return true;
}
