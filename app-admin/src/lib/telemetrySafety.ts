const privateKey = /authorization|cookie|password|secret|token|code|state|signature|credential|api.?key|access.?key|connection.?string|client.?assertion|email|phone|firstName|lastName|fullName|displayName|prompt|completion|reasoning|arguments|body|headers|message|stack|errorDetails/i;
const opaqueSegment = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[a-z0-9_-]{24,})$/i;

export function routeTemplate(value: string): string {
  try {
    const path = new URL(value, "https://telemetry.invalid").pathname;
    return path.split("/").map((segment, index, parts) =>
      opaqueSegment.test(segment) || /^(reset-password|password-reset|traces|capture)$/i.test(parts[index - 1] ?? "")
        ? ":id" : segment,
    ).join("/");
  } catch {
    return "/unknown";
  }
}

export function safeTelemetryUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${routeTemplate(url.pathname)}`;
  } catch {
    return routeTemplate(value);
  }
}

// One last outbound gate covers auto-collected payloads as well as handled errors.
// Free-form error text and request content are never necessary for browser KPIs.
export function sanitizeTelemetry(value: unknown, key = "", seen = new WeakSet<object>(), depth = 0): unknown {
  if ((privateKey.test(key) && key !== "resultCode") || /^(errors?|details?)$/i.test(key)) return "[redacted]";
  if (depth > 12) return "[omitted]";
  if (typeof value === "string") {
    if (value.trimStart().startsWith("{") || value.trimStart().startsWith("[")) {
      try { return JSON.stringify(sanitizeTelemetry(JSON.parse(value), "", seen, depth + 1)); } catch { /* Not serialized structured telemetry. */ }
    }
    if (value.startsWith("/")) return routeTemplate(value);
    if (key === "target" && !value.includes("://")) return value.split(/[?#]/)[0].replace(/^[^@]+@/, "");
    if (/^(url|uri|data|refUri)$/i.test(key) || /^https?:\/\//i.test(value))
      return safeTelemetryUrl(value);
    if (/^(name|operation|ai\.operation\.name)$/i.test(key) && (value.includes("/") || value.includes("?")))
      return value.replace(/(?:https?:\/\/[^\s]+|\/[^\s]+)/g, match => safeTelemetryUrl(match));
    return value
      .replace(/https?:\/\/[^\s"'<>]+/gi, match => safeTelemetryUrl(match))
      .replace(/\/[^\s"'<>]*\?[^\s"'<>]*/g, match => routeTemplate(match))
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[redacted]")
      .replace(/\b(?:password|secret|token|authorization|code|state|sig|credential|api.?key|access.?key|connection.?string|client.?assertion)\s*[:=]\s*["']?[^,\s"'&]+/gi, "[redacted]")
      .slice(0, 1024);
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: "[redacted]" };
  if (Array.isArray(value)) return value.slice(0, 100).map(entry => sanitizeTelemetry(entry, key, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
    [childKey, sanitizeTelemetry(child, childKey, seen, depth + 1)],
  ));
}

export function classifyFailure(error: unknown): string {
  const candidate = error as { name?: string; message?: string; status?: number; response?: { status?: number; errors?: unknown[] } };
  if (/session.*(?:changed|expired)|authorization.*generation/i.test(candidate?.message ?? "")) return "authorization-cancelled";
  if (candidate?.name === "AbortError" || candidate?.name === "CancelledError") return "cancelled";
  if (candidate?.name === "TimeoutError") return "timeout";
  const status = candidate?.status ?? candidate?.response?.status;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "throttled";
  if (candidate?.response?.errors?.length) return "graphql-error";
  if (status && status >= 500) return "upstream-failure";
  if (status && status >= 400) return "rejected";
  return "application-failure";
}
