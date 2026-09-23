// Self-contained browser OAuth client for the AdventureWorks MCP authorization
// server hosted by api-mcp. Implements Authorization Code + PKCE (S256) using the
// Web Crypto API only — no external dependencies and no client secret.
//
// Design notes / security posture (demo):
//  - The authorization server re-authenticates the AdventureWorks user server-side
//    (api-mcp `/login`), so this client never handles the user's password.
//  - PKCE verifier + state live in sessionStorage for the duration of the redirect
//    round-trip only and are removed as soon as the code is exchanged.
//  - The short-lived (~10 min) access token is kept in sessionStorage (not
//    localStorage) so it is scoped to the tab/session and cleared on logout or
//    user switch. Raw tokens are never rendered in the UI by default.
import { getApiMcpUrl } from "@/lib/utils";

const CLIENT_ID = "adventureworks-admin";
const PKCE_KEY = "mcp_oauth_pkce";
const TOKEN_KEY = "mcp_oauth_token";

// Scopes the admin client may request. The authorization server intersects these
// with the signed-in employee's role-derived scopes, so requesting the full set
// simply yields whatever the seeded role actually grants (great for inspection).
export const ADMIN_REQUESTED_SCOPES = [
  "mcp.access",
  "products.read",
  "sales.read",
  "customers.read",
  "inventory.read",
  "orders.read",
  "orders.write",
  "manufacturing.read",
  "manufacturing.write",
  "admin.read",
  "admin.write",
  "mcp.admin",
];

export interface McpTokenClaims {
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

/** Canonical resource indicator (RFC 8707) — the MCP endpoint URL. */
export function getResourceIdentifier(): string {
  return getApiMcpUrl().replace(/\/$/, "");
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

/** Decode a JWT payload for display only. This performs NO signature validation
 * (enforcement is entirely server-side); it is used to show issued claims. */
export function decodeTokenClaims(token: string): McpTokenClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as McpTokenClaims;
  } catch {
    return null;
  }
}

/** Begin Authorization Code + PKCE (S256): builds the challenge, stores the
 * verifier/state, and redirects the browser to the authorization endpoint. */
export async function beginAuthorization(loginHint?: string): Promise<void> {
  const base = getOAuthBaseUrl();
  if (!base) {
    throw new Error("MCP authorization server URL is not configured.");
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
    scope: ADMIN_REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const resource = getResourceIdentifier();
  if (resource) params.set("resource", resource);
  if (loginHint) params.set("login_hint", loginHint);

  window.location.assign(`${base}/authorize?${params.toString()}`);
}

export interface CallbackResult {
  ok: boolean;
  error?: string;
  returnTo?: string;
}

/** Handle the redirect back from the authorization server: validates state and
 * exchanges the code (with the PKCE verifier) for a resource-bound access token. */
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
  const resource = getResourceIdentifier();
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

/** Returns the current (unexpired) MCP access token, or null. */
export function getAccessToken(): string | null {
  return readStoredToken()?.accessToken ?? null;
}

/** Returns the space-delimited granted scopes from the stored token. */
export function getGrantedScopes(): string[] {
  const t = readStoredToken();
  if (!t) return [];
  const claims = decodeTokenClaims(t.accessToken);
  const fromClaim = claims?.scope ?? (Array.isArray(claims?.scp) ? claims?.scp.join(" ") : claims?.scp);
  const raw = (typeof fromClaim === "string" && fromClaim) || t.scope || "";
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** Decoded claims of the current token, for the inspection view. */
export function getCurrentClaims(): McpTokenClaims | null {
  const t = readStoredToken();
  return t ? decodeTokenClaims(t.accessToken) : null;
}

export function isAuthorized(): boolean {
  return readStoredToken() !== null;
}

/** Clears all MCP authorization context. Call on logout / user switch. */
export function clearAuthorization(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PKCE_KEY);
}
