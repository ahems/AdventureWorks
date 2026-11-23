import { z } from "zod";
import { getFunctionsApiUrl } from "@/lib/utils";
import { getFunctionsAccessToken, getTabAuthorizationGeneration, isTabAuthorizationGenerationCurrent } from "./dabAuth";

export const monitoringRanges = ["1h", "6h", "24h"] as const;
export type MonitoringRange = typeof monitoringRanges[number];
const sourceSchema = z.object({
  id: z.string(),
  status: z.enum(["available", "no-data", "stale", "forbidden", "throttled", "unavailable"]),
  asOf: z.string(),
  reason: z.string().nullable(),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(100),
});
const summarySchema = z.object({
  asOf: z.string(), range: z.enum(monitoringRanges),
  status: z.enum(["available", "partial", "unavailable", "no-data"]),
  ingestionNote: z.string(), sources: z.array(sourceSchema),
  links: z.object({ workbook: z.string().optional(), grafana: z.string().optional(), applicationInsights: z.string().optional() }),
});
const captureSchema = z.object({
  id: z.string(), scopeType: z.enum(["session", "job"]), scopeId: z.string(),
  createdAt: z.string(), expiresAt: z.string(), maxRootOperations: z.number(),
  rootOperations: z.number(), status: z.enum(["active", "stopped", "expired", "exhausted"]),
});
const capturesSchema = z.object({ asOf: z.string(), captures: z.array(captureSchema), notice: z.string() });
const capturedFieldSchema = z.object({ text: z.string().nullable(), originalBytes: z.number(), truncated: z.boolean(), omitted: z.boolean() });
const traceSchema = z.object({
  asOf: z.string(), traceId: z.string(), status: z.string(), source: sourceSchema,
  richContent: z.array(z.object({
    spanId: z.string(),
    fields: z.object({
      input: capturedFieldSchema.optional(),
      output: capturedFieldSchema.optional(),
      reasoningSummary: capturedFieldSchema.optional(),
    }),
  })).max(100).optional(),
});

export type MonitoringSource = z.infer<typeof sourceSchema>;
export type MonitoringSummary = z.infer<typeof summarySchema>;
export type CaptureGrant = z.infer<typeof captureSchema>;
export type CaptureStatus = z.infer<typeof capturesSchema>;
export type MonitoringTrace = z.infer<typeof traceSchema>;

export class MonitoringError extends Error {
  constructor(public status: number) {
    super(status === 401 || status === 403 ? "Monitoring access denied." :
      status === 429 ? "Monitoring queries are throttled." : "Monitoring data is unavailable.");
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const generation = getTabAuthorizationGeneration();
  const ensureSession = () => {
    if (!isTabAuthorizationGenerationCurrent(generation)) throw new Error("The monitoring session has changed.");
  };
  ensureSession();
  const token = await getFunctionsAccessToken();
  ensureSession();
  if (!token) throw new MonitoringError(401);
  const response = await fetch(`${getFunctionsApiUrl().replace(/\/$/, "")}/api/monitoring${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  ensureSession();
  if (!response.ok) throw new MonitoringError(response.status);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("The monitoring response has an unsupported format."); }
  const parsed = schema.safeParse(payload);
  ensureSession();
  if (!parsed.success) throw new Error("The monitoring response has an unsupported format.");
  return parsed.data;
}

export const monitoringService = {
  summary: (range: MonitoringRange, signal?: AbortSignal) => request(`/summary?range=${range}`, summarySchema, { signal }),
  trace: (traceId: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{32}$/i.test(traceId) || /^0{32}$/.test(traceId)) throw new Error("Enter a nonzero 32-character hexadecimal trace ID.");
    return request(`/traces/${encodeURIComponent(traceId)}`, traceSchema, { signal });
  },
  captures: (signal?: AbortSignal) => request("/capture", capturesSchema, { signal }),
  startCapture: (scopeType: "session" | "job", scopeId: string) =>
    request("/capture", captureSchema, { method: "POST", body: JSON.stringify({ scopeType, scopeId }) }),
  stopCapture: (id: string) => request(`/capture/${encodeURIComponent(id)}`, captureSchema, { method: "DELETE" }),
};
