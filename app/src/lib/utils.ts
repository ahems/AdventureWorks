import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines class names with Tailwind CSS class merging
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Get the GraphQL API URL from runtime config or environment
 */
export function getGraphQLApiUrl(): string {
  return (
    (window as any).APP_CONFIG?.API_URL ||
    import.meta.env.VITE_API_URL ||
    "http://localhost:5000/graphql"
  );
}

/**
 * Get the Functions API URL from runtime config or environment
 */
export function getFunctionsApiUrl(): string {
  return (
    (window as any).APP_CONFIG?.API_FUNCTIONS_URL ||
    import.meta.env.VITE_API_FUNCTIONS_URL ||
    "http://localhost:7071"
  );
}

/**
 * Convert GraphQL API URL to REST API URL
 * Handles both /graphql and /graphql/ patterns
 */
export function getRestApiUrl(): string {
  const graphqlUrl = getGraphQLApiUrl();
  // Remove /graphql or /graphql/ and add /api
  return graphqlUrl.replace(/\/graphql\/?$/, "/api");
}
