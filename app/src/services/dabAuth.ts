// Self-contained browser OAuth client for a Data API Builder (DAB) resource token,
// used by the e-shop (consumer) app.
//
// Mirrors the admin `dabAuth.ts`: Authorization Code + PKCE (S256) against the
// same api-mcp authorization server, no client secret, requesting the DAB
// RFC 8707 `resource` so the resulting token's `aud` is the one Data API Builder
// validates. The token is stored under DAB-specific sessionStorage keys and is
// attached to GraphQL requests only while a consumer is signed in — anonymous
// catalog browsing sends no Authorization header and continues to work.
//
// Security posture (demo):
//  - The authorization server re-authenticates the AdventureWorks consumer
//    server-side (api-mcp `/login`); this client never handles the password.
//  - PKCE verifier + state live in sessionStorage only for the redirect
//    round-trip and are removed as soon as the code is exchanged.
//  - The short-lived (~10 min) access token is kept in sessionStorage (not
//    localStorage) so it is tab-scoped and cleared on logout / account switch.
import { getApiMcpUrl } from "@/lib/utils";

const CLIENT_ID = "adventureworks-eshop";
const PKCE_KEY = "dab_oauth_pkce";
const TOKEN_KEY = "dab_oauth_token";

// Scopes the consumer client may request. The authorization server intersects
// these with the signed-in consumer's seeded role-derived scopes. DAB authorizes
// by ROLE (X-MS-API-ROLE vs the `roles` claim); scopes matter to MCP and to the
// requirement that a token carries at least one granted scope to be issued.
export const DAB_CONSUMER_REQUESTED_SCOPES = [
  "mcp.access",
  "products.read",
  "orders.read",
  "orders.write",
];

export interface DabTokenClaims {
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
 * Canonical DAB resource indicator (RFC 8707). Derived from the api-mcp URL so
 * it always equals the authorization server's `{PublicBaseUrl}/dab` and DAB's
 * configured `DAB_JWT_AUDIENCE` — never a hard-coded hostname.
 */
export function getDabResourceIdentifier(): string {
  const mcp = getApiMcpUrl();
  if (!mcp) return "";
  try {
    return new URL("/dab", mcp).toString().replace(/\/$/, "");
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

/** Decode a JWT payload for display / role selection only. Performs NO signature
 * validation (enforcement is entirely server-side at DAB). */
export function decodeTokenClaims(token: string): DabTokenClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as DabTokenClaims;
  } catch {
    return null;
  }
}

/** True when a DAB PKCE flow is currently pending. */
export function hasPendingAuthorization(): boolean {
  return sessionStorage.getItem(PKCE_KEY) !== null;
}

/** Begin Authorization Code + PKCE (S256) for a DAB-resource token. */
export async function beginAuthorization(loginHint?: string): Promise<void> {
  const base = getOAuthBaseUrl();
  if (!base) {
    throw new Error("DAB authorization server URL is not configured.");
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
    scope: DAB_CONSUMER_REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const resource = getDabResourceIdentifier();
  if (resource) params.set("resource", resource);
  if (loginHint) params.set("login_hint", loginHint);

  window.location.assign(`${base}/authorize?${params.toString()}`);
}

export interface CallbackResult {
  ok: boolean;
  error?: string;
  returnTo?: string;
}

/** Handle the redirect back from the authorization server for the DAB flow. */
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
  const resource = getDabResourceIdentifier();
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

/** Returns the current (unexpired) DAB access token, or null. */
export function getAccessToken(): string | null {
  return readStoredToken()?.accessToken ?? null;
}

/** Decoded claims of the current DAB token. */
export function getCurrentClaims(): DabTokenClaims | null {
  const t = readStoredToken();
  return t ? decodeTokenClaims(t.accessToken) : null;
}

/**
 * The application role to send in the DAB `X-MS-API-ROLE` header. DAB validates
 * this against the caller's `roles` claim and applies that role's per-entity
 * permissions (a consumer is additionally constrained to their own records by
 * server-issued ownership claims). Falls back to `role` then `category`.
 */
export function getDabRole(): string | null {
  const claims = getCurrentClaims();
  if (!claims) return null;
  const roles = claims.roles;
  if (Array.isArray(roles)) {
    const first = roles.find((r) => typeof r === "string" && r);
    if (first) return first;
  } else if (typeof roles === "string" && roles) {
    return roles;
  }
  if (typeof claims.role === "string" && claims.role) return claims.role;
  if (typeof claims.category === "string" && claims.category) return claims.category;
  return null;
}

export function isAuthorized(): boolean {
  return readStoredToken() !== null;
}

/** Clears all DAB authorization context. Call on logout / account switch. */
export function clearAuthorization(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PKCE_KEY);
}
