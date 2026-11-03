export type HealthStatus =
  | "checking" | "healthy" | "unhealthy" | "timeout" | "unknown"
  | "running" | "configured" | "not-configured" | "not-run";
export type HealthGroup = "services" | "capabilities" | "data";
export type CheckMode = "quick" | "capabilities" | "data";

export interface HealthCheck {
  id: string;
  name: string;
  group: HealthGroup;
  required: boolean;
  status: HealthStatus;
  message?: string;
  endpoint?: string;
  responseTimeMs?: number;
  checkedAt?: string;
}

export interface HealthConfig {
  graphqlUrl: string;
  functionsUrl: string;
}

const dependencyDefinitions = [
  ["sql", "Azure SQL", "services", true],
  ["blobs", "Blob storage", "services", true],
  ["queues", "Queue storage", "services", true],
  ["tables", "Table storage", "services", true],
  ["mcp", "MCP process", "services", true],
  ["mcp-ready", "MCP dependencies", "services", true],
  ["oauth", "OAuth discovery", "services", true],
  ["webpubsub-service", "Web PubSub service", "capabilities", false],
  ["files", "Seed log file storage", "capabilities", false],
  ["openai", "Azure OpenAI configuration", "capabilities", false],
  ["foundry", "Foundry agent configuration", "capabilities", false],
  ["manufacturing-agent", "Hosted manufacturing agent configuration", "capabilities", false],
  ["email", "Email configuration", "capabilities", false],
  ["order-emails", "Order notification emails", "capabilities", false],
  ["telemetry", "Backend telemetry configuration", "capabilities", false],
] as const;

const definitions: Array<[string, string, HealthGroup, boolean]> = [
  ["graphql", "Catalog API (DAB)", "services", true],
  ["functions", "Azure Functions process", "services", true],
  ...dependencyDefinitions.map(([id, name, group, required]): [string, string, HealthGroup, boolean] =>
    [id, name, group, required]),
  ["semantic", "Semantic search / embeddings", "capabilities", false],
  ["suggestions", "AI search suggestions", "capabilities", false],
  ["agent-status", "Agent status endpoint", "capabilities", false],
  ["catalog-meta", "Help Me Choose catalog", "capabilities", false],
  ["sitemap", "Sitemap", "capabilities", false],
  ["openapi", "OpenAPI specification", "capabilities", false],
  ["seed", "Database seed job", "data", false],
  ["images", "AI image metadata", "data", false],
];

export function initialHealthChecks(): HealthCheck[] {
  return definitions.map(([id, name, group, required]) =>
    ({ id, name, group, required, status: "not-run" }));
}

export function checkIdsForMode(mode: CheckMode): string[] {
  if (mode === "quick") return ["graphql", "functions", ...dependencyDefinitions.map(([id]) => id)];
  if (mode === "data") return ["seed", "images"];
  return ["semantic", "suggestions", "agent-status", "catalog-meta", "sitemap", "openapi"];
}

export function overallHealth(checks: HealthCheck[]): string {
  const required = checks.filter(check => check.required);
  if (required.some(check => check.status === "checking" || check.status === "not-run"))
    return "Checking core services";
  return required.length > 0 && required.every(check => check.status === "healthy")
    ? "Core services operational" : "Core service issues detected";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Invalid JSON response structure.");
  return value;
}

function arrayField(value: unknown, field: string): unknown[] {
  const data = requireRecord(value);
  if (!Array.isArray(data[field])) throw new Error(`Invalid response: missing ${field} array.`);
  return data[field];
}

function graphqlItems(value: unknown, entity: string, requirePagination = false): { items: unknown[]; hasNextPage: boolean } {
  const response = requireRecord(value);
  if ("errors" in response && !Array.isArray(response.errors))
    throw new Error("Invalid GraphQL errors response.");
  if (Array.isArray(response.errors) && response.errors.length > 0)
    throw new Error("GraphQL returned errors. See Application Insights.");
  const connection = requireRecord(requireRecord(response.data)[entity]);
  if (!Array.isArray(connection.items)) throw new Error("Invalid GraphQL items response.");
  if (requirePagination && typeof connection.hasNextPage !== "boolean")
    throw new Error("Invalid GraphQL pagination response.");
  return { items: connection.items, hasNextPage: connection.hasNextPage === true };
}

export function validateDependencyReport(value: unknown): Map<string, Partial<HealthCheck>> {
  const report = requireRecord(value);
  if (!["healthy", "unhealthy"].includes(String(report.status)) ||
      typeof report.checkedAt !== "string" || !Number.isFinite(Date.parse(report.checkedAt)))
    throw new Error("Invalid dependency health report.");
  const checks = arrayField(report, "checks");
  const validStatuses = ["healthy", "unhealthy", "timeout", "not-configured", "configured", "unknown"];
  const result = new Map<string, Partial<HealthCheck>>();
  for (const [id] of dependencyDefinitions) {
    const matches = checks.filter(item => record(item) && item.id === id);
    const check = matches.length === 1 ? requireRecord(matches[0]) : null;
    if (!check || !validStatuses.includes(String(check.status)) ||
        typeof check.message !== "string" || typeof check.responseTimeMs !== "number" ||
        !Number.isFinite(check.responseTimeMs) || check.responseTimeMs < 0)
      throw new Error(`Invalid dependency result: ${id}.`);
    result.set(id, {
      status: check.status as HealthStatus, message: check.message,
      responseTimeMs: check.responseTimeMs, checkedAt: report.checkedAt,
    });
  }
  return result;
}

export function validateSeedStatus(value: unknown): Partial<HealthCheck> {
  const data = requireRecord(value);
  if (data.status === "completed")
    return { status: "healthy", message: typeof data.durationHuman === "string"
      ? `Completed in ${data.durationHuman}.` : "Seed job completed." };
  if (data.status === "running")
    return { status: "running", message: typeof data.runningForHuman === "string"
      ? `Running for ${data.runningForHuman}.` : "Seed job is still running." };
  if (data.status === "failed") return { status: "unhealthy", message: "Seed job failed. See seed logs." };
  if (data.status === "unknown")
    return { status: "unknown", message: "Seed status could not be established. Check storage configuration and logs." };
  throw new Error("Invalid seed status response.");
}

interface Probe {
  ids: string[];
  endpoint: string;
  body?: object;
  format?: "text";
  validate: (data: unknown) => Map<string, Partial<HealthCheck>>;
  allowUnavailableReport?: boolean;
}

function single(id: string, validate: (data: unknown) => Partial<HealthCheck>) {
  return (data: unknown) => new Map([[id, validate(data)]]);
}

function buildProbes(config: HealthConfig, mode: CheckMode): Probe[] {
  const functionsUrl = config.functionsUrl.replace(/\/+$/, "");
  if (mode === "quick") return [
    {
      ids: ["graphql"], endpoint: config.graphqlUrl,
      body: { query: "{ productCategories(first: 1) { items { ProductCategoryID } } }" },
      validate: single("graphql", data => {
        const { items } = graphqlItems(data, "productCategories");
        if (items.some(item => !record(item) || typeof item.ProductCategoryID !== "number"))
          throw new Error("Invalid category record.");
        return { status: "healthy", message: "GraphQL schema and SQL read path responding. Data completeness is checked separately." };
      }),
    },
    {
      ids: ["functions"], endpoint: `${functionsUrl}/api/health`,
      validate: single("functions", data => {
        if (requireRecord(data).status !== "healthy") throw new Error("Invalid Functions liveness response.");
        return { status: "healthy", message: "Functions process responding; dependency readiness is checked separately." };
      }),
    },
    {
      ids: dependencyDefinitions.map(([id]) => id),
      endpoint: `${functionsUrl}/api/health/readiness`, allowUnavailableReport: true,
      validate: validateDependencyReport,
    },
  ];
  if (mode === "data") return [
    { ids: ["seed"], endpoint: `${functionsUrl}/api/seed/status`, validate: single("seed", validateSeedStatus) },
    {
      ids: ["images"], endpoint: config.graphqlUrl,
      body: { query: "{ productPhotos(filter: { ProductPhotoID: { gte: 1000 } }, first: 100) { items { ProductPhotoID } hasNextPage } }" },
      validate: single("images", data => {
        const { items, hasNextPage } = graphqlItems(data, "productPhotos", true);
        if (items.some(item => !record(item) || typeof item.ProductPhotoID !== "number" || item.ProductPhotoID < 1000))
          throw new Error("Invalid AI image metadata record.");
        return { status: items.length ? "healthy" : "unknown",
          message: items.length
            ? `${items.length}${hasNextPage ? "+" : ""} AI photo metadata rows found (sample capped at 100). Image files are not fetched.`
            : "No AI photo metadata found. This is a data-readiness warning, not an API outage." };
      }),
    },
  ];
  return [
    {
      ids: ["semantic"], endpoint: `${functionsUrl}/api/search/semantic`,
      body: { query: "red bikes", topN: 5, cultureId: "en" },
      validate: single("semantic", data => {
        const results = arrayField(data, "results");
        if (results.some(item => !record(item) ||
            (typeof item.productID !== "number" && typeof item.ProductID !== "number")))
          throw new Error("Invalid semantic search result.");
        return { status: results.length ? "healthy" : "unknown",
          message: results.length ? `${results.length} search results; embedding inference and SQL vector reads succeeded.`
            : "Search responded with no matches; embedding/data readiness is inconclusive." };
      }),
    },
    {
      ids: ["suggestions"], endpoint: `${functionsUrl}/api/search/suggestions?q=bike`,
      validate: single("suggestions", data => {
        const results = arrayField(data, "suggestions");
        if (!results.every(item => typeof item === "string")) throw new Error("Invalid search suggestions.");
        return { status: results.length ? "healthy" : "unknown", message: `${results.length} suggestions returned.` };
      }),
    },
    {
      ids: ["agent-status"], endpoint: `${functionsUrl}/api/agent/status`,
      validate: single("agent-status", data => {
        if (requireRecord(data).status !== "operational") throw new Error("Invalid agent status response.");
        return { status: "healthy", message: "Agent status route responds. No conversation, model invocation, or MCP tool execution tested." };
      }),
    },
    {
      ids: ["catalog-meta"], endpoint: `${functionsUrl}/api/helpme/catalog-meta`,
      validate: single("catalog-meta", data => {
        const colors = arrayField(data, "colors");
        const sizes = arrayField(data, "bikeSizes");
        if (![...colors, ...sizes].every(item => typeof item === "string"))
          throw new Error("Invalid catalog metadata.");
        return { status: colors.length && sizes.length ? "healthy" : "unknown",
          message: `${colors.length} colors and ${sizes.length} bike sizes returned; no recommendation agent invoked.` };
      }),
    },
    {
      ids: ["sitemap"], endpoint: `${functionsUrl}/api/sitemap.xml`, format: "text",
      validate: single("sitemap", data => {
        if (typeof data !== "string") throw new Error("Invalid sitemap XML response.");
        const xml = new DOMParser().parseFromString(data, "application/xml");
        if (xml.querySelector("parsererror") || xml.documentElement.localName !== "urlset" ||
            xml.documentElement.namespaceURI !== "http://www.sitemaps.org/schemas/sitemap/0.9" ||
            xml.getElementsByTagName("loc").length === 0)
          throw new Error("Invalid sitemap XML response.");
        return { status: "healthy", message: "Sitemap XML contains URL entries." };
      }),
    },
    {
      ids: ["openapi"], endpoint: `${functionsUrl}/api/openapi.json`,
      validate: single("openapi", data => {
        const doc = requireRecord(data);
        const info = requireRecord(doc.info ?? doc.Info);
        const paths = requireRecord(doc.paths ?? doc.Paths);
        if (typeof (info.title ?? info.Title) !== "string" || Object.keys(paths).length === 0)
          throw new Error("Invalid OpenAPI document.");
        return { status: "healthy", message: "OpenAPI document structure validated; this does not test every documented route." };
      }),
    },
  ];
}

export async function runHealthChecks(
  config: HealthConfig, mode: CheckMode, signal: AbortSignal,
  onResult: (check: HealthCheck) => void,
): Promise<void> {
  const checks = initialHealthChecks();
  await Promise.all(buildProbes(config, mode).map(async probe => {
    const start = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeoutMs = mode === "capabilities" ? 90000 : 60000;
    const timeout = setTimeout(abort, timeoutMs);
    const emit = (id: string, result: Partial<HealthCheck>) => {
      if (signal.aborted) return;
      const definition = checks.find(check => check.id === id);
      if (!definition) throw new Error(`Unknown health check: ${id}.`);
      onResult({ ...definition, endpoint: probe.endpoint,
        responseTimeMs: Math.round(performance.now() - start),
        checkedAt: new Date().toISOString(), ...result });
    };
    try {
      const response = await fetch(probe.endpoint, {
        method: probe.body ? "POST" : "GET",
        ...(probe.body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(probe.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok && !(probe.allowUnavailableReport && response.status === 503))
        throw new Error(`HTTP ${response.status}. Endpoint unavailable or access denied.`);
      const data: unknown = probe.format === "text" ? await response.text() : await response.json();
      const results = probe.validate(data);
      for (const id of probe.ids) {
        const result = results.get(id);
        if (!result) throw new Error(`Missing result: ${id}.`);
        emit(id, result);
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      const timedOut = controller.signal.aborted;
      for (const id of probe.ids) emit(id, {
        status: timedOut ? "timeout" : "unhealthy",
        message: timedOut ? `Request exceeded ${timeoutMs / 1000}s. Retry when the service is ready.`
          : error instanceof Error ? error.message : "Health check failed with an unexpected error.",
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }));
}
