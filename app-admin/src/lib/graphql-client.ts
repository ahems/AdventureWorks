import { GraphQLClient } from "graphql-request";
import {
  getDabRole,
  getValidAccessToken,
  hasSession,
  refreshAccessToken,
} from "@/services/dabAuth";

type AppWindow = Window & { APP_CONFIG?: { API_URL?: string } };

const getApiUrl = (): string => {
  if (
    typeof window !== "undefined" &&
    (window as AppWindow).APP_CONFIG?.API_URL
  ) {
    const configUrl = (window as AppWindow).APP_CONFIG!.API_URL!;
    if (configUrl.includes("#{")) {
      return import.meta.env.VITE_API_URL || "http://localhost:5000/graphql";
    }
    return configUrl;
  }
  return import.meta.env.VITE_API_URL || "http://localhost:5000/graphql";
};

/**
 * Authenticated fetch for Data API Builder. When the signed-in employee has a
 * DAB-resource session (obtained silently at sign-in via the api-mcp OAuth server),
 * attach a fresh access token in `Authorization` together with the seeded role in
 * `X-MS-API-ROLE`, so DAB authorizes the request against that role's per-entity
 * permissions. The token is renewed with its refresh token shortly before expiry.
 *
 * DAB reports a missing/expired token as HTTP 200 with an `AUTH_NOT_AUTHENTICATED`
 * GraphQL error, so the response is inspected: on that error the token is force-
 * refreshed and the request retried once. If the session cannot be renewed the
 * request fails loudly (and `DAB_SESSION_LOST_EVENT` sends the user back to sign in)
 * instead of silently rendering empty pages.
 *
 * With no session the headers are omitted entirely, preserving DAB's anonymous
 * behaviour for pre-login lookups (email/person during sign-in).
 */
const applyAuth = (init: RequestInit | undefined, token: string | null): RequestInit => {
  const headers = new Headers(init?.headers);
  if (token) {
    const scheme = "Bearer";
    headers.set("Authorization", scheme + " " + token);
    const role = getDabRole();
    if (role) headers.set("X-MS-API-ROLE", role);
  } else {
    headers.delete("Authorization");
    headers.delete("X-MS-API-ROLE");
  }
  return { ...init, headers };
};

const isNotAuthenticated = async (response: Response): Promise<boolean> => {
  if (response.status === 401) return true;
  try {
    const text = await response.clone().text();
    return text.includes("AUTH_NOT_AUTHENTICATED");
  } catch {
    return false;
  }
};

const authenticatedFetch: typeof fetch = async (input, init) => {
  if (!hasSession()) {
    return fetch(input, applyAuth(init, null));
  }

  const token = await getValidAccessToken();
  const response = await fetch(input, applyAuth(init, token));
  if (!(await isNotAuthenticated(response))) {
    return response;
  }

  const renewed = await refreshAccessToken(true);
  if (!renewed) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  return fetch(input, applyAuth(init, renewed));
};

export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: { "Content-Type": "application/json" },
  fetch: authenticatedFetch,
});
