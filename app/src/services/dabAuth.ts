// DAB role selection for the e-shop. The storefront acquires its DAB token with
// the AdventureWorks credentials grant in `eshopOAuth.ts`, which stores it under
// `dab_oauth_token`; this module only reads that token's claims to choose the
// `X-MS-API-ROLE` header. Anonymous catalog browsing sends no role.

const TOKEN_KEY = "dab_oauth_token";

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

/**
 * The application role to send in the DAB `X-MS-API-ROLE` header. DAB validates
 * this against the caller's `roles` claim and applies that role's per-entity
 * permissions (a consumer is additionally constrained to their own records by
 * server-issued ownership claims). Falls back to `role` then `category`.
 */
export function getDabRole(): string | null {
  const t = readStoredToken();
  const claims = t ? decodeTokenClaims(t.accessToken) : null;
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
