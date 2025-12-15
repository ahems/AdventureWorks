import { GraphQLClient } from "graphql-request";

// Get API URL from runtime config or environment variables
const getApiUrl = (): string => {
  // First check window.APP_CONFIG (set at runtime via config.js)
  if (typeof window !== "undefined" && (window as any).APP_CONFIG?.API_URL) {
    return (window as any).APP_CONFIG.API_URL;
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
