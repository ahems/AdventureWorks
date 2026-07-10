import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type AppWindow = Window & {
  APP_CONFIG?: {
    API_URL?: string;
    API_FUNCTIONS_URL?: string;
    API_MCP_URL?: string;
    APP_URL?: string;
    MCP_INSPECTOR_URL?: string;
    APP_MANUFACTURING_URL?: string;
  };
};

export function getFunctionsApiUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.API_FUNCTIONS_URL ||
    import.meta.env.VITE_API_FUNCTIONS_URL ||
    "http://localhost:7071"
  );
}

export function getGraphQLApiUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.API_URL ||
    import.meta.env.VITE_API_URL ||
    "http://localhost:5000/graphql"
  );
}

export function getMcpInspectorUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.MCP_INSPECTOR_URL ||
    import.meta.env.VITE_MCP_INSPECTOR_URL ||
    ""
  );
}

/** Returns the custom AdventureWorks MCP server URL (includes /mcp path). */
export function getApiMcpUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.API_MCP_URL ||
    import.meta.env.VITE_API_MCP_URL ||
    ""
  );
}

/** Returns the DAB Data API MCP endpoint URL (derived from the GraphQL URL). */
export function getDabMcpUrl(): string {
  try {
    const base = getGraphQLApiUrl();
    return new URL("/mcp", base).toString();
  } catch {
    return "";
  }
}

/**
 * Builds an MCP Inspector URL pre-configured for a given server, so the user
 * only needs to click Connect — no manual URL entry required.
 */
export function buildInspectorUrl(serverUrl: string): string {
  const inspectorBase = getMcpInspectorUrl();
  if (!inspectorBase || !serverUrl) return inspectorBase;
  const url = new URL(inspectorBase);
  url.searchParams.set("transport", "streamable-http");
  url.searchParams.set("serverUrl", serverUrl);
  // Tell the Inspector React app where its proxy server is.
  // The proxy (port 6277) is exposed via nginx at /proxy/ on the same origin.
  // Without this, the React app defaults to http://localhost:6277 (the user's machine).
  const proxyUrl = inspectorBase.replace(/\/$/, "") + "/proxy";
  url.searchParams.set("MCP_PROXY_FULL_ADDRESS", proxyUrl);
  return url.toString();
}

export function getRestApiUrl(): string {
  return getGraphQLApiUrl().replace(/\/graphql\/?$/, "/api");
}

/** Returns the customer-facing app base URL (no trailing slash). Empty string if not configured. */
export function getAppUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.APP_URL ||
    import.meta.env.VITE_APP_URL ||
    ""
  ).replace(/\/$/, "");
}

/** Returns the manufacturing portal base URL (no trailing slash). Empty string if not configured. */
export function getManufacturingUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.APP_MANUFACTURING_URL ||
    import.meta.env.VITE_APP_MANUFACTURING_URL ||
    ""
  ).replace(/\/$/, "");
}
