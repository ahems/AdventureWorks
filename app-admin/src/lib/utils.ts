import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type AppWindow = Window & {
  APP_CONFIG?: { API_URL?: string; API_FUNCTIONS_URL?: string };
};

export function getFunctionsApiUrl(): string {
  return (
    (window as AppWindow).APP_CONFIG?.API_FUNCTIONS_URL ||
    import.meta.env.VITE_API_FUNCTIONS_URL ||
    "http://localhost:7071"
  );
}

export function getRestApiUrl(): string {
  const graphqlUrl =
    (window as AppWindow).APP_CONFIG?.API_URL ||
    import.meta.env.VITE_API_URL ||
    "http://localhost:5000/graphql";
  return graphqlUrl.replace(/\/graphql\/?$/, "/api");
}
