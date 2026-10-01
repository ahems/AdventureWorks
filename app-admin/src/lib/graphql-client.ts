import { GraphQLClient } from "graphql-request";
import { getAccessToken, getDabRole } from "@/services/dabAuth";

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
 * Per-request headers. When the signed-in employee has obtained a DAB-resource
 * access token (Authorization Code + PKCE via the api-mcp OAuth server), attach
 * it in the `Authorization` request header together with the seeded role in
 * `X-MS-API-ROLE` so Data API Builder authorizes the request against that
 * role's per-entity permissions. When no token is present the headers are
 * omitted entirely, preserving DAB's anonymous behaviour for pre-login lookups
 * (email/person during sign-in).
 */
const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getAccessToken();
  if (token) {
    const scheme = "Bearer";
    headers["Authorization"] = scheme + " " + token;
    const role = getDabRole();
    if (role) headers["X-MS-API-ROLE"] = role;
  }
  return headers;
};

export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: buildHeaders,
});
