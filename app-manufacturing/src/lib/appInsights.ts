import { ApplicationInsights } from "@microsoft/applicationinsights-web";
import { API_MCP_URL, MANUFACTURING_BASE, ODATA_BASE } from "@/config/api";
import { sanitizeTelemetry, classifyFailure } from "./telemetrySafety";
import { startBrowserSignals } from "./browserSignals";

const CLOUD_ROLE_NAME = "app-manufacturing";

type AppWindow = Window & {
  APP_CONFIG?: { APPINSIGHTS_CONNECTIONSTRING?: string };
};

let appInsights: ApplicationInsights | null = null;
const reportedErrors = new WeakSet<object>();

// Only send W3C correlation headers to this solution's own APIs (never to identity providers or third parties).
const getCorrelationDomains = (): string[] =>
  [ODATA_BASE, MANUFACTURING_BASE, API_MCP_URL]
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
        distributedTracingMode: 2,
        enableRequestHeaderTracking: false,
        enableResponseHeaderTracking: false,
        // Browsers are deprecating the 'unload' event (Permissions Policy violation).
        disablePageUnloadEvents: ["unload"],
      },
    });
    appInsights.loadAppInsights();
    appInsights.addTelemetryInitializer((item) => {
      item.tags = item.tags ?? {};
      item.tags["ai.cloud.role"] = CLOUD_ROLE_NAME;
      item.tags["ai.application.ver"] = import.meta.env.VITE_BUILD_VERSION || "unknown";
      Object.assign(item, sanitizeTelemetry(item));
    });
    startBrowserSignals(trackEvent, getCorrelationDomains());
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
  appInsights?.trackException({ exception: new Error("Handled browser failure") }, { ...properties, errorClass: error.name });
};

export const trackEvent = (name: string, properties?: Record<string, unknown>) => {
  appInsights?.trackEvent({ name }, properties);
};

export function reportHandledFailure(error: unknown, operation = "query") {
  if (error && typeof error === "object") {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  trackEvent("browser.handled-outcome", { operation, outcome: classifyFailure(error) });
}
