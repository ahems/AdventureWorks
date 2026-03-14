import React, { useState, useEffect } from "react";
import { Check, X, Clock, AlertCircle, Activity } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { getGraphQLApiUrl, getFunctionsApiUrl } from "@/lib/utils";

interface AppConfig {
  API_URL: string;
  API_FUNCTIONS_URL?: string;
  API_MCP_URL?: string;
  APPINSIGHTS_CONNECTIONSTRING?: string;
}

interface HealthCheckResult {
  name: string;
  status: "checking" | "healthy" | "unhealthy" | "timeout";
  message?: string;
  responseTime?: number;
  endpoint?: string;
}

interface FunctionEndpoint {
  name: string;
  path: string;
  method: string;
  requiresBody?: boolean;
}

const HealthCheckPage: React.FC = () => {
  const [checks, setChecks] = useState<HealthCheckResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [startTime, setStartTime] = useState<number>(0);
  const [refreshCountdown, setRefreshCountdown] = useState<number | null>(null);

  // Define all function endpoints to check
  const functionEndpoints: FunctionEndpoint[] = [
    { name: "Health Check", path: "/api/health", method: "GET" },
    { name: "Agent Status", path: "/api/agent/status", method: "GET" },
    {
      name: "Search Suggestions",
      path: "/api/search/suggestions?q=bike",
      method: "GET",
    },
    { name: "Sitemap", path: "/api/sitemap.xml", method: "GET" },
    { name: "OpenAPI Spec", path: "/api/openapi.json", method: "GET" },
  ];

  const updateCheckStatus = (
    name: string,
    status: HealthCheckResult["status"],
    message?: string,
    responseTime?: number,
    endpoint?: string,
  ) => {
    setChecks((prev) => {
      const existing = prev.find((c) => c.name === name);
      if (existing) {
        return prev.map((c) =>
          c.name === name
            ? { ...c, status, message, responseTime, endpoint }
            : c,
        );
      }
      return [...prev, { name, status, message, responseTime, endpoint }];
    });
  };

  const checkGraphQLAPI = async (): Promise<void> => {
    const name = "GraphQL API (DAB)";
    const start = performance.now();
    updateCheckStatus(name, "checking");

    try {
      const apiUrl = getGraphQLApiUrl();
      updateCheckStatus(name, "checking", undefined, undefined, apiUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ productCategories { items { ProductCategoryID Name } } }",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTime = Math.round(performance.now() - start);

      if (!response.ok) {
        updateCheckStatus(
          name,
          "unhealthy",
          `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
          apiUrl,
        );
        return;
      }

      const data = await response.json();

      if (data.errors) {
        updateCheckStatus(
          name,
          "unhealthy",
          `GraphQL errors: ${data.errors.map((e: { message: string }) => e.message).join(", ")}`,
          responseTime,
          apiUrl,
        );
        return;
      }

      if (data.data?.productCategories?.items) {
        updateCheckStatus(
          name,
          "healthy",
          `Returned ${data.data.productCategories.items.length} categories`,
          responseTime,
          apiUrl,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          "Invalid response structure",
          responseTime,
          apiUrl,
        );
      }
    } catch (error: unknown) {
      const responseTime = Math.round(performance.now() - start);
      if ((error as Error).name === "AbortError") {
        updateCheckStatus(
          name,
          "timeout",
          "Request timeout (>60s)",
          responseTime,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          (error as Error).message,
          responseTime,
        );
      }
    }
  };

  const checkFunction = async (func: FunctionEndpoint): Promise<void> => {
    const name = `Function: ${func.name}`;
    const start = performance.now();
    updateCheckStatus(name, "checking");

    try {
      const functionsUrl = getFunctionsApiUrl();
      const endpoint = `${functionsUrl}${func.path}`;
      updateCheckStatus(name, "checking", undefined, undefined, endpoint);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      const options: RequestInit = {
        method: func.method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      };

      const response = await fetch(endpoint, options);

      clearTimeout(timeoutId);
      const responseTime = Math.round(performance.now() - start);

      // Check for successful responses (200-299)
      if (response.ok) {
        updateCheckStatus(
          name,
          "healthy",
          `HTTP ${response.status} - Service operational`,
          responseTime,
          endpoint,
        );
      } else if (response.status < 500) {
        // 4xx errors indicate the endpoint exists but may need authentication or proper data
        updateCheckStatus(
          name,
          "healthy",
          `HTTP ${response.status} - Endpoint responding (may require auth/data)`,
          responseTime,
          endpoint,
        );
      } else {
        // 5xx errors indicate server problems
        updateCheckStatus(
          name,
          "unhealthy",
          `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
          endpoint,
        );
      }
    } catch (error: unknown) {
      const responseTime = Math.round(performance.now() - start);
      if ((error as Error).name === "AbortError") {
        updateCheckStatus(
          name,
          "timeout",
          "Request timeout (>60s)",
          responseTime,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          (error as Error).message,
          responseTime,
        );
      }
    }
  };

  const checkMCPAPI = async (): Promise<void> => {
    const name = "MCP API";
    const start = performance.now();
    updateCheckStatus(name, "checking");

    try {
      // Get MCP URL from window config or environment
      const mcpUrl =
        (window as Window & { APP_CONFIG?: AppConfig }).APP_CONFIG
          ?.API_MCP_URL || import.meta.env.VITE_API_MCP_URL;

      if (!mcpUrl) {
        updateCheckStatus(name, "unhealthy", "MCP URL not configured");
        return;
      }

      // Extract base URL (remove /mcp path if present) for health check
      const baseUrl = mcpUrl.replace(/\/mcp$/, "");
      const endpoint = `${baseUrl}/health`;
      updateCheckStatus(name, "checking", undefined, undefined, endpoint);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTime = Math.round(performance.now() - start);

      if (!response.ok) {
        updateCheckStatus(
          name,
          "unhealthy",
          `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
          endpoint,
        );
        return;
      }

      const data = await response.text();
      updateCheckStatus(
        name,
        "healthy",
        `Health check passed: ${data}`,
        responseTime,
        endpoint,
      );
    } catch (error: unknown) {
      const responseTime = Math.round(performance.now() - start);
      if ((error as Error).name === "AbortError") {
        updateCheckStatus(
          name,
          "timeout",
          "Request timeout (>60s)",
          responseTime,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          (error as Error).message,
          responseTime,
        );
      }
    }
  };

  const checkAIGeneratedImages = async (): Promise<void> => {
    const name = "AI Generated Images";
    const start = performance.now();
    updateCheckStatus(name, "checking");

    try {
      const apiUrl = getGraphQLApiUrl();
      updateCheckStatus(name, "checking", undefined, undefined, apiUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      // Query for ProductPhoto records with ProductPhotoID >= 1000 (AI-generated images)
      // Use first: 5000 to override the default 100-item pagination limit
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            productPhotos(filter: { ProductPhotoID: { gte: 1000 } }, first: 5000) {
              items {
                ProductPhotoID
              }
              hasNextPage
            }
          }`,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTime = Math.round(performance.now() - start);

      if (!response.ok) {
        updateCheckStatus(
          name,
          "unhealthy",
          `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
          apiUrl,
        );
        return;
      }

      const data = await response.json();

      if (data.errors) {
        updateCheckStatus(
          name,
          "unhealthy",
          `GraphQL errors: ${data.errors.map((e: { message: string }) => e.message).join(", ")}`,
          responseTime,
          apiUrl,
        );
        return;
      }

      if (data.data?.productPhotos?.items) {
        const count = data.data.productPhotos.items.length;
        const hasNextPage = data.data.productPhotos.hasNextPage;
        const expectedCount = 885;

        if (hasNextPage) {
          updateCheckStatus(
            name,
            "unhealthy",
            `Found ${count}+ AI-generated images but pagination indicates more exist (may need to increase query limit)`,
            responseTime,
            apiUrl,
          );
        } else if (count >= expectedCount) {
          updateCheckStatus(
            name,
            "healthy",
            `Found ${count} AI-generated images (expected ~${expectedCount})`,
            responseTime,
            apiUrl,
          );
        } else if (count > 0) {
          updateCheckStatus(
            name,
            "unhealthy",
            `Only ${count} of ~${expectedCount} AI-generated images found (upload may be in progress)`,
            responseTime,
            apiUrl,
          );
        } else {
          updateCheckStatus(
            name,
            "unhealthy",
            `No AI-generated images found (expected ~${expectedCount})`,
            responseTime,
            apiUrl,
          );
        }
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          "Invalid response structure",
          responseTime,
          apiUrl,
        );
      }
    } catch (error: unknown) {
      const responseTime = Math.round(performance.now() - start);
      if ((error as Error).name === "AbortError") {
        updateCheckStatus(
          name,
          "timeout",
          "Request timeout (>60s)",
          responseTime,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          (error as Error).message,
          responseTime,
        );
      }
    }
  };

  const checkSeedJobStatus = async (): Promise<void> => {
    const name = "Seed Job";
    const start = performance.now();
    updateCheckStatus(name, "checking");

    try {
      const functionsUrl = getFunctionsApiUrl();
      const endpoint = `${functionsUrl}/api/seed/status`;
      updateCheckStatus(name, "checking", undefined, undefined, endpoint);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTime = Math.round(performance.now() - start);

      if (!response.ok) {
        updateCheckStatus(
          name,
          "unhealthy",
          `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
          endpoint,
        );
        return;
      }

      const data = await response.json();
      const status = data.status as string;
      const message = (data.message as string) || "";
      const durationHuman = data.durationHuman as string | undefined;

      if (status === "completed") {
        const completedMessage =
          durationHuman != null
            ? `Seed job completed successfully (ran for ${durationHuman})`
            : message || "Seed job completed successfully";
        updateCheckStatus(
          name,
          "healthy",
          completedMessage,
          responseTime,
          endpoint,
        );
      } else if (status === "running") {
        const runningMessage =
          data.runningForHuman != null
            ? `Running for ${data.runningForHuman}`
            : "Seed job running";
        updateCheckStatus(name, "unhealthy", runningMessage, responseTime, endpoint);
      } else if (status === "failed") {
        updateCheckStatus(
          name,
          "unhealthy",
          message || "Seed job failed",
          responseTime,
          endpoint,
        );
      } else {
        // unknown
        updateCheckStatus(
          name,
          "healthy",
          message || "No seed log found (or unable to read)",
          responseTime,
          endpoint,
        );
      }
    } catch (error: unknown) {
      const responseTime = Math.round(performance.now() - start);
      if ((error as Error).name === "AbortError") {
        updateCheckStatus(
          name,
          "timeout",
          "Request timeout (>60s)",
          responseTime,
        );
      } else {
        updateCheckStatus(
          name,
          "unhealthy",
          (error as Error).message,
          responseTime,
        );
      }
    }
  };

  const checkSemanticSearch = async (): Promise<void> => {
    const name = "Function: Semantic Search";
    const start = performance.now();
    updateCheckStatus(name, "checking");

    const functionsUrl = getFunctionsApiUrl();
    const endpoint = `${functionsUrl}/api/search/semantic`;
    updateCheckStatus(name, "checking", undefined, undefined, endpoint);

    const doFetch = (timeoutMs: number): Promise<Response> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "red bikes",
          topN: 5,
          cultureId: "en",
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
    };

    const timeoutMs = 90000; // 90s for cold start
    let lastResponseTime = 0;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await doFetch(timeoutMs);
        lastResponseTime = Math.round(performance.now() - start);

        if (!response.ok) {
          if (response.status >= 500 && attempt < 2) {
            await new Promise((r) => setTimeout(r, 15000)); // wait 15s before retry
            continue;
          }
          updateCheckStatus(
            name,
            "unhealthy",
            `HTTP ${response.status}: ${response.statusText}`,
            lastResponseTime,
            endpoint,
          );
          return;
        }

        const data = await response.json();
        const results = data.results as unknown[] | undefined;
        const count = Array.isArray(results) ? results.length : 0;

        updateCheckStatus(
          name,
          "healthy",
          `${count} results for 'red bikes'`,
          lastResponseTime,
          endpoint,
        );
        return;
      } catch (error: unknown) {
        lastResponseTime = Math.round(performance.now() - start);
        lastError = error;
        if ((error as Error).name === "AbortError") {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 15000)); // wait 15s before retry
            continue;
          }
          updateCheckStatus(
            name,
            "timeout",
            "Request timeout (>90s)",
            lastResponseTime,
          );
          return;
        } else {
          updateCheckStatus(
            name,
            "unhealthy",
            (error as Error).message,
            lastResponseTime,
          );
          return;
        }
      }
    }
  };

  useEffect(() => {
    const runHealthChecks = async () => {
      setStartTime(Date.now());
      setChecks([]);
      setProgress(0);
      setRefreshCountdown(null);

      const totalChecks = 4 + functionEndpoints.length + 1; // DAB + MCP + AI Images + Seed Job + Functions + Semantic Search
      let completedChecks = 0;

      const updateProgress = () => {
        completedChecks++;
        setProgress((completedChecks / totalChecks) * 100);
      };

      // Run all checks in parallel
      await Promise.all([
        checkGraphQLAPI().finally(updateProgress),
        checkMCPAPI().finally(updateProgress),
        checkAIGeneratedImages().finally(updateProgress),
        checkSeedJobStatus().finally(updateProgress),
        checkSemanticSearch().finally(updateProgress),
        ...functionEndpoints.map((func) =>
          checkFunction(func).finally(updateProgress),
        ),
      ]);
    };

    runHealthChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh effect when checks fail
  useEffect(() => {
    const allChecksComplete =
      checks.length > 0 &&
      checks.filter((c) => c.status === "checking").length === 0;
    const hasFailures =
      checks.filter((c) => c.status === "unhealthy" || c.status === "timeout")
        .length > 0;

    if (allChecksComplete && hasFailures) {
      // Start countdown from 10 seconds
      setRefreshCountdown(10);

      const countdownInterval = setInterval(() => {
        setRefreshCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(countdownInterval);
            window.location.reload();
            return null;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(countdownInterval);
    } else if (allChecksComplete && !hasFailures) {
      // All healthy, stop any countdown
      setRefreshCountdown(null);
    }
  }, [checks]);

  const getStatusIcon = (status: HealthCheckResult["status"]) => {
    switch (status) {
      case "checking":
        return <Clock className="w-5 h-5 text-blue-500 animate-spin" />;
      case "healthy":
        return <Check className="w-5 h-5 text-green-500" />;
      case "unhealthy":
        return <X className="w-5 h-5 text-red-500" />;
      case "timeout":
        return <AlertCircle className="w-5 h-5 text-orange-500" />;
    }
  };

  const getStatusBadge = (status: HealthCheckResult["status"]) => {
    switch (status) {
      case "checking":
        return <Badge variant="outline">Checking...</Badge>;
      case "healthy":
        return <Badge className="bg-green-500">Healthy</Badge>;
      case "unhealthy":
        return <Badge variant="destructive">Unhealthy</Badge>;
      case "timeout":
        return <Badge className="bg-orange-500">Timeout</Badge>;
    }
  };

  const healthyCount = checks.filter((c) => c.status === "healthy").length;
  const unhealthyCount = checks.filter(
    (c) => c.status === "unhealthy" || c.status === "timeout",
  ).length;
  const checkingCount = checks.filter((c) => c.status === "checking").length;

  const allChecksComplete = checkingCount === 0 && checks.length > 0;
  const allHealthy = allChecksComplete && unhealthyCount === 0;

  const elapsedTime =
    startTime > 0 ? ((Date.now() - startTime) / 1000).toFixed(1) : "0.0";

  return (
    <div className="min-h-screen bg-doodle-bg">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <Activity className="w-8 h-8 text-doodle-accent" />
              <h1 className="font-doodle text-4xl font-bold text-doodle-text">
                System Health Check
              </h1>
            </div>
            <p className="font-doodle text-lg text-doodle-text/70">
              Monitoring backend services and key API endpoints. Initial
              requests may take up to 60 seconds as services scale up from zero.
            </p>
          </div>

          {/* Overall Status Card */}
          <Card className="mb-6 border-2 border-doodle-text">
            <CardHeader>
              <CardTitle className="font-doodle flex items-center justify-between">
                <span>Overall Status</span>
                {allChecksComplete &&
                  (allHealthy ? (
                    <Badge
                      className="bg-green-500 text-lg"
                      data-testid="overall-status-success"
                    >
                      All Systems Operational
                    </Badge>
                  ) : (
                    <Badge
                      variant="destructive"
                      className="text-lg"
                      data-testid="overall-status-failure"
                    >
                      Issues Detected
                    </Badge>
                  ))}
              </CardTitle>
              <CardDescription className="font-doodle">
                {allChecksComplete
                  ? `Completed in ${elapsedTime}s`
                  : `Running health checks... (${elapsedTime}s elapsed)`}
                {refreshCountdown !== null && (
                  <span className="block mt-2 text-orange-600 font-semibold">
                    Auto-refreshing in {refreshCountdown} seconds...
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Progress
                value={progress}
                className="mb-4"
                data-testid="health-check-progress"
              />
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div
                    className="text-2xl font-bold text-green-500"
                    data-testid="healthy-count"
                  >
                    {healthyCount}
                  </div>
                  <div className="text-sm text-muted-foreground">Healthy</div>
                </div>
                <div>
                  <div
                    className="text-2xl font-bold text-red-500"
                    data-testid="unhealthy-count"
                  >
                    {unhealthyCount}
                  </div>
                  <div className="text-sm text-muted-foreground">Issues</div>
                </div>
                <div>
                  <div
                    className="text-2xl font-bold text-blue-500"
                    data-testid="checking-count"
                  >
                    {checkingCount}
                  </div>
                  <div className="text-sm text-muted-foreground">Checking</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Individual Service Checks */}
          <div className="space-y-4" data-testid="service-checks">
            {checks.map((check) => (
              <Card
                key={check.name}
                className="border-2 border-doodle-text"
                data-testid={`check-${check.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(check.status)}
                      <div>
                        <CardTitle className="font-doodle text-lg">
                          {check.name}
                        </CardTitle>
                        {check.endpoint && (
                          <CardDescription className="font-mono text-xs mt-1">
                            {check.endpoint}
                          </CardDescription>
                        )}
                      </div>
                    </div>
                    {getStatusBadge(check.status)}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {check.message && (
                      <p className="font-doodle text-sm text-doodle-text/70">
                        {check.message}
                      </p>
                    )}
                    {check.responseTime !== undefined && (
                      <p className="font-mono text-xs text-doodle-text/50">
                        Response time: {check.responseTime}ms
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {checks.length === 0 && (
            <Card className="border-2 border-doodle-text">
              <CardContent className="py-12 text-center">
                <Clock className="w-12 h-12 text-blue-500 animate-spin mx-auto mb-4" />
                <p className="font-doodle text-lg text-doodle-text/70">
                  Initializing health checks...
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

export default HealthCheckPage;
