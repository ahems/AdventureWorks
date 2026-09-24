import { GraphQLClient } from "graphql-request";
import { trackError } from "@/lib/appInsights";
import { getAccessToken, getDabRole } from "@/services/dabAuth";

// Get API URL from runtime config or environment variables
const getApiUrl = (): string => {
  // First check window.APP_CONFIG (set at runtime via config.js)
  if (typeof window !== "undefined" && (window as any).APP_CONFIG?.API_URL) {
    const configUrl = (window as any).APP_CONFIG.API_URL;

    // Check if it's a placeholder pattern (#{VAR}#)
    if (configUrl.includes("#{")) {
      trackError(
        "GraphQL Client config URL contains placeholder",
        new Error("Unresolved placeholder in API_URL"),
        {
          component: "graphql-client",
          configUrl,
          fallback:
            import.meta.env.VITE_API_URL || "http://localhost:5000/graphql",
        },
      );
      return import.meta.env.VITE_API_URL || "http://localhost:5000/graphql";
    }

    return configUrl;
  }

  // Fall back to Vite environment variable
  return import.meta.env.VITE_API_URL || "http://localhost:5000/graphql";
};

// Create GraphQL client instance.
//
// Headers are computed per-request: once a signed-in consumer has obtained a
// DAB-resource access token (Authorization Code + PKCE via the api-mcp OAuth
// server), it is attached as a ****** together with the seeded role in
// `X-MS-API-ROLE` so Data API Builder authorizes the request (and constrains a
// consumer to their own records via server-issued ownership claims). Anonymous
// visitors have no token, so no auth headers are sent and public catalog
// browsing continues to work unchanged.
const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getAccessToken();
  if (token) {
    headers["Authorization"] = `******;
    const role = getDabRole();
    if (role) headers["X-MS-API-ROLE"] = role;
  }
  return headers;
};

export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: buildHeaders,
});
