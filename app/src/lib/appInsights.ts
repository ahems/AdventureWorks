import { ApplicationInsights } from "@microsoft/applicationinsights-web";
import { ReactPlugin } from "@microsoft/applicationinsights-react-js";

// Create the React plugin for router tracking
export const reactPlugin = new ReactPlugin();

// Initialize Application Insights
let appInsights: ApplicationInsights | null = null;

export const initAppInsights = () => {
  const connectionString = window.APP_CONFIG?.APPINSIGHTS_CONNECTIONSTRING;

  if (!connectionString) {
    console.warn(
      "[App Insights] No connection string provided - telemetry disabled",
    );
    return null;
  }

  if (appInsights) {
    return appInsights;
  }

  try {
    appInsights = new ApplicationInsights({
      config: {
        connectionString,
        extensions: [reactPlugin],
        enableAutoRouteTracking: true,
        disableAjaxTracking: false,
        autoTrackPageVisitTime: true,
        enableCorsCorrelation: true,
        enableRequestHeaderTracking: true,
        enableResponseHeaderTracking: true,
      },
    });

    appInsights.loadAppInsights();

    // Set authenticated user context if available
    const user = localStorage.getItem("user");
    if (user) {
      try {
        const userData = JSON.parse(user);
        if (userData.CustomerID) {
          appInsights.setAuthenticatedUserContext(
            String(userData.CustomerID),
            undefined,
            true,
          );
        }
      } catch (e) {
        console.warn("[App Insights] Failed to set user context:", e);
      }
    }

    console.log("[App Insights] Initialized successfully");
    return appInsights;
  } catch (error) {
    console.error("[App Insights] Failed to initialize:", error);
    return null;
  }
};

export const getAppInsights = () => appInsights;

// Custom tracking helpers
export const trackEvent = (
  name: string,
  properties?: Record<string, unknown>,
) => {
  if (appInsights) {
    appInsights.trackEvent({ name }, properties);
  }
};

export const trackPageView = (
  name?: string,
  properties?: Record<string, unknown>,
) => {
  if (appInsights) {
    appInsights.trackPageView({ name });
    // Track properties as a separate event since trackPageView doesn't accept properties in the second arg
    if (properties) {
      appInsights.trackEvent(
        { name: `PageView_${name || "Unknown"}` },
        properties,
      );
    }
  }
};

export const trackException = (
  error: Error,
  properties?: Record<string, unknown>,
) => {
  if (appInsights) {
    appInsights.trackException({ exception: error }, properties);
  }
};

export const trackMetric = (
  name: string,
  value: number,
  properties?: Record<string, unknown>,
) => {
  if (appInsights) {
    appInsights.trackMetric({ name, average: value }, properties);
  }
};

// User context management
export const setUserContext = (userId: string) => {
  if (appInsights) {
    appInsights.setAuthenticatedUserContext(userId, undefined, true);
  }
};

export const clearUserContext = () => {
  if (appInsights) {
    appInsights.clearAuthenticatedUserContext();
  }
};

// Helper to track errors with consistent format
export const trackError = (
  message: string,
  error?: unknown,
  properties?: Record<string, unknown>,
) => {
  if (appInsights) {
    if (error instanceof Error) {
      appInsights.trackException(
        { exception: error },
        { ...properties, message },
      );
    } else {
      appInsights.trackException(
        { exception: new Error(message) },
        { ...properties, errorDetails: error },
      );
    }
  }
};
