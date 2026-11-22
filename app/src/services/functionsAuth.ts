// Functions-resource helpers for the e-shop. Tokens come from the AdventureWorks
// credentials grant in `eshopOAuth.ts`; there is no browser redirect flow.
import { getEshopAccessToken } from "@/services/eshopOAuth";

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

/**
 * fetch() wrapper that attaches a fresh Functions access token when the e-shop
 * session is authorized. Anonymous registration and public endpoints stay unchanged.
 */
export async function functionsFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getEshopAccessToken("functions");
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, {
    ...init,
    headers,
  });
}
