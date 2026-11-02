import { GraphQLClient } from "graphql-request";
import { trackError } from "@/lib/appInsights";
import { getDabRole } from "@/services/dabAuth";
import { getEshopAccessToken } from "@/services/eshopOAuth";

// Get API URL from runtime config or environment variables
const getApiUrl = (): string => {
  // First check window.APP_CONFIG (set at runtime via config.js)
  const runtimeConfig =
    typeof window !== "undefined"
      ? (window as Window & { APP_CONFIG?: { API_URL?: string } }).APP_CONFIG
      : undefined;
  if (runtimeConfig?.API_URL) {
    const configUrl = runtimeConfig.API_URL;

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
export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: { "Content-Type": "application/json" },
  requestMiddleware: async (request) => {
    const headers = new Headers(request.headers);
    const token = await getEshopAccessToken("dab");
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
      const role = getDabRole();
      if (role) headers.set("X-MS-API-ROLE", role);
    } else {
      headers.delete("Authorization");
      headers.delete("X-MS-API-ROLE");
    }
    return { ...request, headers };
  },
});
