/**
 * Centralized API base URLs.
 *
 * To change an API endpoint, update it here (or set the corresponding
 * VITE_* environment variable in `.env`) — no other files need editing.
 *
 * - ODATA_BASE: primary OData backend (Products, BOM, Work Orders, Vendors, etc.)
 * - MANUFACTURING_BASE: manufacturing simulation / supply / planning functions API
 *
 * In production (container), values are injected at runtime via /config.js into
 * window.APP_CONFIG. In local dev, VITE_* env vars or the fallback defaults are used.
 */

type AppWindow = Window & {
  APP_CONFIG?: {
    ODATA_BASE?: string;
    MANUFACTURING_BASE?: string;
  };
};

const runtimeConfig =
  typeof window !== "undefined" ? (window as AppWindow).APP_CONFIG : undefined;

const DEFAULT_ODATA_BASE = "http://localhost:5000/api";
const DEFAULT_MANUFACTURING_BASE = "http://localhost:7071/api";

export const ODATA_BASE: string =
  runtimeConfig?.ODATA_BASE ||
  (import.meta.env.VITE_ODATA_BASE as string | undefined) ||
  DEFAULT_ODATA_BASE;

export const MANUFACTURING_BASE: string =
  runtimeConfig?.MANUFACTURING_BASE ||
  (import.meta.env.VITE_MANUFACTURING_BASE as string | undefined) ||
  DEFAULT_MANUFACTURING_BASE;
