import { getApiMcpUrl } from "@/lib/utils";

const CLIENT_ID = "adventureworks-eshop";
const GRANT_TYPE =
  "urn:adventureworks:params:oauth:grant-type:eshop-credentials";
const REFRESH_TOKEN_KEY = "eshop_oauth_refresh_token";
const TOKEN_KEYS = {
  dab: "dab_oauth_token",
  functions: "functions_oauth_token",
  mcp: "mcp_oauth_token",
} as const;
const REQUESTED_SCOPES = [
  "mcp.access",
  "products.read",
  "customers.read",
  "customers.write",
  "orders.read",
  "orders.write",
  "offline_access",
];
const REFRESH_WINDOW_SECONDS = 60;

export type EshopResource = keyof typeof TOKEN_KEYS;

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

let refreshInFlight: Promise<void> | null = null;

function getTokenEndpoint(): string {
  const mcpUrl = getApiMcpUrl();
  if (!mcpUrl) {
    throw new Error("The AdventureWorks authorization service is not configured.");
  }
  const baseUrl = mcpUrl.replace(/\/mcp\/?$/i, "").replace(/\/$/, "");
  return `${baseUrl}/token`;
}

function getResourceIdentifier(resource: EshopResource): string {
  const mcpUrl = getApiMcpUrl();
  if (!mcpUrl) {
    throw new Error("The AdventureWorks authorization service is not configured.");
  }
  return resource === "mcp"
    ? mcpUrl.replace(/\/$/, "")
    : new URL(`/${resource}`, mcpUrl).toString().replace(/\/$/, "");
}

function readToken(resource: EshopResource): StoredToken | null {
  const raw = sessionStorage.getItem(TOKEN_KEYS[resource]);
  if (!raw) return null;
  try {
    const token = JSON.parse(raw) as StoredToken;
    if (
      typeof token.accessToken !== "string" ||
      typeof token.expiresAt !== "number"
    ) {
      throw new Error("Invalid stored OAuth token");
    }
    return token;
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEYS[resource]);
    throw error;
  }
}

function storeToken(resource: EshopResource, response: TokenResponse): void {
  if (!response.access_token) {
    throw new Error("The authorization service returned no access token.");
  }
  const stored: StoredToken = {
    accessToken: response.access_token,
    expiresAt:
      Math.floor(Date.now() / 1000) + (response.expires_in ?? 600),
    scope: response.scope ?? "",
  };
  sessionStorage.setItem(TOKEN_KEYS[resource], JSON.stringify(stored));
  if (response.refresh_token) {
    sessionStorage.setItem(REFRESH_TOKEN_KEY, response.refresh_token);
  }
}

async function postTokenRequest(parameters: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(getTokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters.toString(),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 400 || response.status === 401
        ? "Sign-in failed. Check your email and password and try again."
        : `The authorization service returned HTTP ${response.status}.`,
    );
  }

  const token = (await response.json()) as TokenResponse;
  if (!token.access_token) {
    throw new Error("The authorization service returned an invalid token response.");
  }
  return token;
}

/** Exchange AdventureWorks credentials for DAB and Functions tokens without a redirect. */
export async function signInWithEshopCredentials(
  username: string,
  password: string,
): Promise<void> {
  clearEshopOAuthSession();

  try {
    const dabParameters = new URLSearchParams({
      grant_type: GRANT_TYPE,
      client_id: CLIENT_ID,
      username,
      password,
      resource: getResourceIdentifier("dab"),
      scope: REQUESTED_SCOPES.join(" "),
    });
    const dabToken = await postTokenRequest(dabParameters);
    if (!dabToken.refresh_token) {
      throw new Error("The authorization service did not issue a session refresh token.");
    }
    storeToken("dab", dabToken);

    await getEshopAccessToken("functions", true);
  } catch (error) {
    clearEshopOAuthSession();
    throw error;
  }
}

async function refreshResourceToken(resource: EshopResource): Promise<void> {
  const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error("Your secure session has expired. Please sign in again.");
  }

  const parameters = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    resource: getResourceIdentifier(resource),
  });
  const token = await postTokenRequest(parameters);
  storeToken(resource, token);
}

/** Get a valid resource token, refreshing it silently when it is near expiry. */
export async function getEshopAccessToken(
  resource: EshopResource,
  forceRefresh = false,
): Promise<string | null> {
  let token = readToken(resource);
  const now = Math.floor(Date.now() / 1000);
  if (
    !forceRefresh &&
    token &&
    token.expiresAt > now + REFRESH_WINDOW_SECONDS
  ) {
    return token.accessToken;
  }

  if (!sessionStorage.getItem(REFRESH_TOKEN_KEY)) {
    return token && token.expiresAt > now ? token.accessToken : null;
  }

  if (refreshInFlight) {
    await refreshInFlight;
    token = readToken(resource);
    if (
      !forceRefresh &&
      token &&
      token.expiresAt > Math.floor(Date.now() / 1000) + REFRESH_WINDOW_SECONDS
    ) {
      return token.accessToken;
    }
  }

  const currentRefresh = refreshResourceToken(resource);
  refreshInFlight = currentRefresh;
  try {
    await currentRefresh;
  } catch (error) {
    clearEshopOAuthSession();
    throw error;
  } finally {
    if (refreshInFlight === currentRefresh) refreshInFlight = null;
  }

  token = readToken(resource);
  if (!token || token.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("The authorization service returned an expired access token.");
  }
  return token.accessToken;
}

/** Restore both protected-resource sessions after a page reload in the same tab. */
export async function restoreEshopOAuthSession(): Promise<boolean> {
  if (!sessionStorage.getItem(REFRESH_TOKEN_KEY)) return false;
  const [dabToken, functionsToken] = await Promise.all([
    getEshopAccessToken("dab"),
    getEshopAccessToken("functions"),
  ]);
  return Boolean(dabToken && functionsToken);
}

export function clearEshopOAuthSession(): void {
  sessionStorage.removeItem(TOKEN_KEYS.dab);
  sessionStorage.removeItem(TOKEN_KEYS.functions);
  sessionStorage.removeItem(TOKEN_KEYS.mcp);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  sessionStorage.removeItem("dab_oauth_pkce");
  sessionStorage.removeItem("functions_oauth_pkce");
}
