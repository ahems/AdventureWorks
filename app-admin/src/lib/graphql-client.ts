import { GraphQLClient } from "graphql-request";

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

export const graphqlClient = new GraphQLClient(getApiUrl(), {
  headers: {
    "Content-Type": "application/json",
  },
});
