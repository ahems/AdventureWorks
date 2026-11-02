import { ApplicationInsights } from "@microsoft/applicationinsights-web";
import { getApiMcpUrl, getFunctionsApiUrl, getGraphQLApiUrl } from "./utils";

const CLOUD_ROLE_NAME = "app-admin";

type AppWindow = Window & {
  APP_CONFIG?: { APPINSIGHTS_CONNECTIONSTRING?: string };
};

let appInsights: ApplicationInsights | null = null;

// Only send W3C correlation headers to this solution's own APIs (never to identity providers or third parties).
const getCorrelationDomains = (): string[] =>
  [getGraphQLApiUrl(), getFunctionsApiUrl(), getApiMcpUrl()]
    .map((url) => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })
    .filter((host) => host.length > 0);

export const initAppInsights = (): ApplicationInsights | null => {
  if (appInsights) return appInsights;

  const connectionString =
    (window as AppWindow).APP_CONFIG?.APPINSIGHTS_CONNECTIONSTRING ||
    (import.meta.env.VITE_APPINSIGHTS_CONNECTIONSTRING as string | undefined);

  if (!connectionString) {
    console.warn("[App Insights] No connection string provided - telemetry disabled");
    return null;
  }

  try {
    appInsights = new ApplicationInsights({
      config: {
        connectionString,
        enableAutoRouteTracking: true,
        autoTrackPageVisitTime: true,
        enableUnhandledPromiseRejectionTracking: true,
        enableCorsCorrelation: true,
        correlationHeaderDomains: getCorrelationDomains(),
        enableRequestHeaderTracking: true,
        enableResponseHeaderTracking: true,
        // Browsers are deprecating the 'unload' event (Permissions Policy violation).
        disablePageUnloadEvents: ["unload"],
      },
    });
    appInsights.loadAppInsights();
    appInsights.addTelemetryInitializer((item) => {
      item.tags = item.tags ?? {};
      item.tags["ai.cloud.role"] = CLOUD_ROLE_NAME;
    });
    appInsights.trackPageView();
    return appInsights;
  } catch (error) {
    console.error("[App Insights] Failed to initialize:", error);
    appInsights = null;
    return null;
  }
};

export const getAppInsights = () => appInsights;

export const trackException = (error: Error, properties?: Record<string, unknown>) => {
  appInsights?.trackException({ exception: error }, properties);
};

export const trackEvent = (name: string, properties?: Record<string, unknown>) => {
  appInsights?.trackEvent({ name }, properties);
};
