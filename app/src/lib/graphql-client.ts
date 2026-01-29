import { GraphQLClient } from "graphql-request";
import { trackError } from "@/lib/appInsights";

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

// Create GraphQL client instance
export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: {
    "Content-Type": "application/json",
  },
});
