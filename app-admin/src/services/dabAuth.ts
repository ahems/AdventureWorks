// Self-contained browser OAuth client for a Data API Builder (DAB) resource token.
//
// Talks to the api-mcp authorization server with Authorization Code + PKCE (S256)
// and no client secret, requesting the RFC 8707 resource `{api-mcp}/dab`. DAB
// validates that audience and rejects tokens issued for any other resource.
//
// Security posture (demo):
//  - The authorization server re-authenticates the AdventureWorks user
//    server-side (api-mcp `/login`); this client never handles the password.
//  - PKCE verifier + state live in sessionStorage only for the redirect
//    round-trip and are removed as soon as the code is exchanged.
//  - Silent sign-in: when the employee signs in to the admin app, `startSilentSignIn`
//    also signs them in to api-mcp and runs this flow. api-mcp skips the consent page
//    for first-party AdventureWorks clients, so the user sees nothing but a brief
//    redirect. `offline_access` yields a refresh token so the short-lived (~10 min)
//    access token is renewed in the background for the rest of the session.
//  - The access + refresh token are kept in localStorage so every admin tab shares
//    one session; they are cleared on logout / user switch. Concurrent refreshes are
//    serialized with the Web Locks API (refresh tokens are single-use upstream).
import { getApiMcpUrl } from "@/lib/utils";

const CLIENT_ID = "adventureworks-admin";
const PKCE_KEY = "dab_oauth_pkce";
const TOKEN_KEY = "dab_oauth_token";
const MCP_TOKEN_KEY = "mcp_oauth_token";

// Scopes the admin client may request for DAB access. The authorization server
// intersects these with the signed-in employee's seeded role-derived scopes, so
// requesting the full set simply yields whatever the role actually grants. DAB
// authorizes by ROLE (X-MS-API-ROLE vs the `roles` claim), not by scope, but at
// least one granted scope is required for the server to issue a token at all.
export const DAB_ADMIN_REQUESTED_SCOPES = [
  "offline_access",
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
  refreshToken?: string;
}

/** Fired on `window` when the DAB session can no longer be renewed (sign in again). */
export const DAB_SESSION_LOST_EVENT = "dab-session-lost";

/** Renew the access token this many seconds before it expires. */
const REFRESH_SKEW_SECONDS = 60;

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

/** True when a DAB PKCE flow is currently pending (redirect round-trip in progress). */
export function hasPendingAuthorization(): boolean {
  return sessionStorage.getItem(PKCE_KEY) !== null;
}

/** Builds the `/authorize` URL and stores the PKCE verifier/state for the callback. */
async function buildAuthorizeUrl(returnTo: string, loginHint?: string): Promise<string> {
  const base = getOAuthBaseUrl();
  if (!base) {
    throw new Error("DAB authorization server URL is not configured.");
  }

  const verifier = randomUrlSafe(64);
  const state = randomUrlSafe(24);
  const challenge = await s256Challenge(verifier);

  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, state, returnTo }),
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: DAB_ADMIN_REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const resource = getDabResourceIdentifier();
  if (resource) params.set("resource", resource);
  if (loginHint) params.set("login_hint", loginHint);

  return `${base}/authorize?${params.toString()}`;
}

/**
 * Signs the employee in to the api-mcp authorization server with the credentials they
 * just entered in the admin app, then continues straight into the DAB Authorization
 * Code + PKCE flow. Because the admin app is a trusted first-party client, api-mcp
 * issues the code without a consent page and redirects back to `/oauth/callback`,
 * which exchanges it and returns the user to `returnTo`.
 *
 * Implemented as a top-level form POST (not fetch) so the api-mcp session cookie is
 * first-party for the following `/authorize` navigation. The password is sent only to
 * api-mcp's own `/login` endpoint over HTTPS and is never stored.
 */
export async function startSilentSignIn(
  username: string,
  password: string,
  returnTo = "/",
): Promise<void> {
  const base = getOAuthBaseUrl();
  if (!base) {
    throw new Error("DAB authorization server URL is not configured.");
  }

  const authorizeUrl = new URL(await buildAuthorizeUrl(returnTo, username));

  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${base}/login`;
  form.style.display = "none";
  const fields: Record<string, string> = {
    username,
    password,
    returnUrl: `/authorize${authorizeUrl.search}`,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
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

  storeTokenResponse((await res.json()) as TokenResponse);
  return { ok: true, returnTo: pkce.returnTo };
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

function storeTokenResponse(token: TokenResponse, previousRefreshToken?: string): void {
  const stored: StoredToken = {
    accessToken: token.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 600),
    scope: token.scope ?? "",
    refreshToken: token.refresh_token ?? previousRefreshToken,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(stored));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Raw stored session (may hold an expired access token alongside a refresh token). */
function readSession(): StoredToken | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

function readStoredToken(): StoredToken | null {
  const t = readSession();
  return t && t.expiresAt > nowSeconds() ? t : null;
}

/** Returns the current (unexpired) DAB access token, or null. */
export function getAccessToken(): string | null {
  return readStoredToken()?.accessToken ?? null;
}

/** True while there is a usable access token or a refresh token to renew it. */
export function hasSession(): boolean {
  const t = readSession();
  return !!t && (t.expiresAt > nowSeconds() || !!t.refreshToken);
}

function needsRefresh(t: StoredToken | null, force: boolean): boolean {
  if (!t) return false;
  return force || t.expiresAt - REFRESH_SKEW_SECONDS <= nowSeconds();
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request("dab-oauth-refresh", fn) as Promise<T>;
  }
  return fn();
}

let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Exchanges the refresh token for a new access token. Serialized across tabs; a tab
 * that waited on the lock re-reads storage and reuses the token another tab obtained.
 * On a definitive rejection the session is cleared and DAB_SESSION_LOST_EVENT fires.
 */
export async function refreshAccessToken(force = false): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  const startedWith = readSession()?.accessToken;

  inFlightRefresh = withRefreshLock(async () => {
    const current = readSession();
    if (!current?.refreshToken) return getAccessToken();
    // Another tab refreshed while we waited for the lock.
    if (current.accessToken !== startedWith && !needsRefresh(current, false)) {
      return current.accessToken;
    }
    if (!needsRefresh(current, force)) return current.accessToken;

    const base = getOAuthBaseUrl();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
      resource: getDabResourceIdentifier(),
    });

    let res: Response;
    try {
      res = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // Network / cold-start failure: keep the session and retry on the next request.
      return getAccessToken();
    }

    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        clearAuthorization();
        window.dispatchEvent(new Event(DAB_SESSION_LOST_EVENT));
        return null;
      }
      return getAccessToken();
    }

    storeTokenResponse((await res.json()) as TokenResponse, current.refreshToken);
    return getAccessToken();
  }).finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}

/** Canonical MCP resource indicator (RFC 8707) — the api-mcp `/mcp` endpoint URL. */
export function getMcpResourceIdentifier(): string {
  return getApiMcpUrl().replace(/\/$/, "");
}

interface StoredMcpToken {
  accessToken: string;
  expiresAt: number;
  subject?: string;
}

function readMcpToken(): StoredMcpToken | null {
  const raw = localStorage.getItem(MCP_TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredMcpToken;
  } catch {
    localStorage.removeItem(MCP_TOKEN_KEY);
    return null;
  }
}

let inFlightMcp: Promise<string | null> | null = null;

/**
 * Returns a per-user access token for the MCP server, minted silently from the
 * sign-in refresh token (RFC 8707 resource switch). Lets the AI agent call MCP
 * tools as the signed-in admin so role-based tool authorization applies.
 * Returns null when no session exists or the mint fails (agent falls back to
 * its service identity).
 */
export async function getMcpAccessToken(): Promise<string | null> {
  const session = readSession();
  if (!session) return null;
  const subject = decodeTokenClaims(session.accessToken)?.sub as string | undefined;
  const cached = readMcpToken();
  if (cached && cached.subject === subject && cached.expiresAt - REFRESH_SKEW_SECONDS > nowSeconds()) {
    return cached.accessToken;
  }
  if (inFlightMcp) return inFlightMcp;

  inFlightMcp = withRefreshLock(async () => {
    const again = readMcpToken();
    if (again && again.subject === subject && again.expiresAt - REFRESH_SKEW_SECONDS > nowSeconds()) {
      return again.accessToken;
    }
    const current = readSession();
    const resource = getMcpResourceIdentifier();
    if (!current?.refreshToken || !resource) return null;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
      resource,
    });
    try {
      const res = await fetch(`${getOAuthBaseUrl()}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!res.ok) return null;
      const token = (await res.json()) as TokenResponse;
      // Keep the DAB access token; persist only the rotated refresh token.
      if (token.refresh_token) {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...current, refreshToken: token.refresh_token }));
      }
      const stored: StoredMcpToken = {
        accessToken: token.access_token,
        expiresAt: nowSeconds() + (token.expires_in ?? 600),
        subject,
      };
      localStorage.setItem(MCP_TOKEN_KEY, JSON.stringify(stored));
      return stored.accessToken;
    } catch {
      return null;
    }
  }).finally(() => {
    inFlightMcp = null;
  });

  return inFlightMcp;
}

/** Returns a DAB access token, silently renewing it first when it is about to expire. */
export async function getValidAccessToken(): Promise<string | null> {
  const t = readSession();
  if (!t) return null;
  if (!needsRefresh(t, false)) return t.accessToken;
  if (!t.refreshToken) return getAccessToken();
  return refreshAccessToken();
}

/** Decoded claims of the current DAB token, for the inspection view. */
export function getCurrentClaims(): DabTokenClaims | null {
  const t = readStoredToken();
  return t ? decodeTokenClaims(t.accessToken) : null;
}

/**
 * The application role to send in the DAB `X-MS-API-ROLE` header. DAB validates
 * this against the caller's `roles` claim and applies that role's per-entity
 * permissions. Falls back to `role` (singular) then `category`. Returns null
 * when no token is present so callers omit the header (anonymous access).
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

/** Clears all DAB authorization context. Call on logout / user switch. */
export function clearAuthorization(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MCP_TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY); // legacy tab-scoped storage
  sessionStorage.removeItem(PKCE_KEY);
}
