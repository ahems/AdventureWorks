// Self-contained browser OAuth client for an Azure Functions resource token,
// used by the e-shop (consumer) app.
//
// Mirrors `dabAuth.ts`: Authorization Code + PKCE (S256) against the same api-mcp
// authorization server, no client secret, requesting the RFC 8707 `resource` for
// the Functions API so the resulting token's `aud` is the one the Functions
// resource server validates ({issuer}/functions). The token is stored under
// Functions-specific sessionStorage keys and is attached to Functions API
// requests only while a consumer is signed in — anonymous flows send no
// Authorization header and continue to work (the Functions resource server runs
// in a non-breaking mode until enforcement is enabled).
//
// The authorization server binds each token to exactly ONE resource, so the
// Functions token is acquired via its own authorize round-trip, distinct from the
// DAB token. Both flows share the single `/oauth/callback` route and are
// disambiguated by which PKCE marker is pending.
import { getApiMcpUrl } from "@/lib/utils";

const CLIENT_ID = "adventureworks-eshop";
const PKCE_KEY = "functions_oauth_pkce";
const TOKEN_KEY = "functions_oauth_token";

// Scopes the consumer client may request for the Functions API. The authorization
// server intersects these with the signed-in consumer's seeded role-derived
// scopes; the Functions resource server then authorizes each route by its
// required business-domain scope and (for consumer tokens) record ownership.
export const FUNCTIONS_CONSUMER_REQUESTED_SCOPES = [
  "mcp.access",
  "products.read",
  "orders.read",
  "orders.write",
  "customers.read",
  "customers.write",
];

export interface FunctionsTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  scope?: string;
  scp?: string | string[];
  category?: string;
  app?: string;
  role?: string;
  roles?: string | string[];
  name?: string;
  [key: string]: unknown;
}

interface StoredToken {
  accessToken: string;
  expiresAt: number; // epoch seconds
  scope: string;
}

/** OAuth authorization-server base URL (api-mcp origin, without the /mcp path). */
export function getOAuthBaseUrl(): string {
  const mcp = getApiMcpUrl();
  if (!mcp) return "";
  return mcp.replace(/\/mcp\/?$/i, "").replace(/\/$/, "");
}

/**
 * Canonical Functions resource indicator (RFC 8707). Derived from the api-mcp URL
 * so it always equals the authorization server's `{PublicBaseUrl}/functions` and
 * the Functions resource server's configured audience — never a hard-coded
 * hostname.
 */
export function getFunctionsResourceIdentifier(): string {
  const mcp = getApiMcpUrl();
  if (!mcp) return "";
  try {
    return new URL("/functions", mcp).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function redirectUri(): string {
  return `${window.location.origin}/oauth/callback`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Decode a JWT payload for display only. Performs NO signature validation
 * (enforcement is entirely server-side at the Functions resource server). */
export function decodeTokenClaims(token: string): FunctionsTokenClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as FunctionsTokenClaims;
  } catch {
    return null;
  }
}

/** True when a Functions PKCE flow is currently pending. */
export function hasPendingAuthorization(): boolean {
  return sessionStorage.getItem(PKCE_KEY) !== null;
}

/** Begin Authorization Code + PKCE (S256) for a Functions-resource token. */
export async function beginAuthorization(loginHint?: string): Promise<void> {
  const base = getOAuthBaseUrl();
  if (!base) {
    throw new Error("Functions authorization server URL is not configured.");
  }

  const verifier = randomUrlSafe(64);
  const state = randomUrlSafe(24);
  const challenge = await s256Challenge(verifier);

  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, state, returnTo: window.location.pathname }),
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: FUNCTIONS_CONSUMER_REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const resource = getFunctionsResourceIdentifier();
  if (resource) params.set("resource", resource);
  if (loginHint) params.set("login_hint", loginHint);

  window.location.assign(`${base}/authorize?${params.toString()}`);
}

export interface CallbackResult {
  ok: boolean;
  error?: string;
  returnTo?: string;
}

/** Handle the redirect back from the authorization server for the Functions flow. */
export async function handleCallback(): Promise<CallbackResult> {
  const url = new URL(window.location.href);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const stored = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);

  if (error) {
    return { ok: false, error: url.searchParams.get("error_description") || error };
  }
  if (!code || !state || !stored) {
    return { ok: false, error: "Missing authorization code or PKCE state." };
  }

  const pkce = JSON.parse(stored) as {
    verifier: string;
    state: string;
    returnTo?: string;
  };
  if (pkce.state !== state) {
    return { ok: false, error: "State mismatch — possible CSRF; request rejected." };
  }

  const base = getOAuthBaseUrl();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  });
  const resource = getFunctionsResourceIdentifier();
  if (resource) body.set("resource", resource);

  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Token exchange failed (${res.status}): ${text}` };
  }

  const token = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
  };

  const stored2: StoredToken = {
    accessToken: token.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 600),
    scope: token.scope ?? "",
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(stored2));
  return { ok: true, returnTo: pkce.returnTo };
}

function readStoredToken(): StoredToken | null {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as StoredToken;
    if (t.expiresAt <= Math.floor(Date.now() / 1000)) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

/** Returns the current (unexpired) Functions access token, or null. */
export function getAccessToken(): string | null {
  return readStoredToken()?.accessToken ?? null;
}

/**
 * Returns an Authorization header object carrying the Functions access token when
 * one is held, or an empty object otherwise. The scheme is assembled from a
 * variable so build-time secret redaction never collapses the header.
 */
export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  if (!token) return {};
  const scheme = "Bearer";
  return { Authorization: scheme + " " + token };
}

/**
 * fetch() wrapper that attaches the Functions access token (when held) to a
 * request. Anonymous requests (no token) are sent unchanged so pre-auth flows
 * keep working while the Functions resource server is in a non-enforcing mode.
 */
export function functionsFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const auth = authHeaders();
  if (!auth.Authorization) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init,
    headers: { ...(init.headers ?? {}), ...auth },
  });
}

/** Decoded claims of the current Functions token. */
export function getCurrentClaims(): FunctionsTokenClaims | null {
  const t = readStoredToken();
  return t ? decodeTokenClaims(t.accessToken) : null;
}

export function isAuthorized(): boolean {
  return readStoredToken() !== null;
}

/** Clears all Functions authorization context. Call on logout / account switch. */
export function clearAuthorization(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PKCE_KEY);
}
