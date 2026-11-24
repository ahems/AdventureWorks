import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { TableSkeleton, KpiSkeleton } from "@/components/LoadingSkeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, Legend, ResponsiveContainer } from "recharts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/context/AuthContext";
import { useCan } from "@/hooks/useCan";
import { subscribeLiveUpdates } from "@/lib/liveUpdates";
import { monitoringService, monitoringRanges, type MonitoringRange, type MonitoringSource, type CaptureStatus } from "@/services/monitoringService";

const GROUPS = ["manufacturing-agent", "manufacturing-ops", "orders", "warehouse", "supply-chain", "finance", "shopping-simulator", "utilities"];
const PANELS = [
  ["services", "Services & browser experience", "Observed requests, logical failures, latency, dependencies, version and Web Vitals."],
  ["browser", "Browser experience & handled outcomes", "LCP and INP are milliseconds; CLS is unitless. Missing measurements are unavailable. HTTP-200 GraphQL errors are logical failures."],
  ["agents", "Agents, models & tools", "Invocation and model-round counts are different. Missing token usage or evaluation outcomes are unknown, not zero."],
  ["workflows", "Background workflows", "Enqueue, wait, process and terminal outcomes; causal links do not imply unbroken parentage."],
  ["queues", "Queue backlog", "Approximate queue counts are backend observations, not exact admitted workflow totals."],
  ["resources", "Resource pressure & configured limits", "Limits and unsupported tier counters must come from the backend; no inferred headroom."],
  ["ingestion", "Monitoring health & cost", "Sampling, last seen, ingestion bytes, cap state and query errors. Absence does not prove health."],
  ["monitoringHealth", "Monitoring self-diagnostics", "OpenTelemetry SDK/exporter warnings and workspace daily-cap events in the last 24 hours. This is a problem-signal query, not a continuous exporter heartbeat."],
  ["recentTraces", "Recent trace samples", "Sampled traces are not traffic totals. Select a trace to inspect its observed timeline."],
] as const;

function label(key: string) {
  return key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value !== 0 && Math.abs(value) < 0.05) return value > 0 ? "<0.1" : ">-0.1";
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatAge(value: string, now: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "As of unavailable";
  const minutes = Math.round((now - timestamp) / 30_000) / 2;
  if (minutes === 0) return "As of just now";
  const amount = Math.abs(minutes);
  if (amount === 0.5) return `As of 30 seconds ${minutes > 0 ? "ago" : "from now"}`;
  return `As of ${formatNumber(amount)} ${amount === 1 ? "minute" : "minutes"} ${minutes > 0 ? "ago" : "from now"}`;
}

const TONES = {
  good: "text-doodle-green border-doodle-green/40 bg-doodle-green/10",
  warning: "text-primary border-primary/40 bg-primary/10",
  bad: "text-destructive border-destructive/40 bg-destructive/10",
  neutral: "text-muted-foreground border-border",
} as const;

function tone(value: string): keyof typeof TONES {
  if (/^(available|healthy|success|succeeded|active|true)$/.test(value)) return "good";
  if (/^(stale|partial|no-data|warning|telemetry-warning|timeout|throttled|cancelled|authorization-cancelled|expired|exhausted)$/.test(value)) return "warning";
  if (/^(unavailable|forbidden|unauthorized|failed|failure|unhealthy|false)$/.test(value) || /error|failure|denied|daily-cap-reached/.test(value)) return "bad";
  return "neutral";
}

function Explanation({ children, reason }: { children: ReactNode; reason: string }) {
  return <Tooltip><TooltipTrigger asChild>
    <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-4">{children}</span>
  </TooltipTrigger><TooltipContent className="max-w-sm">{reason}</TooltipContent></Tooltip>;
}

function StatusBadge({ value, reason }: { value: string; reason: string }) {
  return <Explanation reason={reason}><span className={cn(badgeVariants({ variant: "outline" }), TONES[tone(value)])}>{value.replace(/-/g, " ").replace(/^./, character => character.toUpperCase())}</span></Explanation>;
}

function Freshness({ asOf, now }: { asOf: string; now: number }) {
  return <Explanation reason={Number.isFinite(Date.parse(asOf))
    ? `Snapshot timestamp: ${formatDate(asOf)}. Age is rounded to the nearest 30 seconds; it does not indicate Azure ingestion completion.`
    : "The server did not provide a valid snapshot timestamp."}>{formatAge(asOf, now)}</Explanation>;
}

function cellReason(column: string, row: MonitoringSource["rows"][number], source: MonitoringSource) {
  const context = [row.reason, source.reason].filter(value => typeof value === "string" && value).join(" ");
  if (column === "signal" && row[column] === "telemetry-warning")
    return `${row.exporter || "OpenTelemetry"} emitted warning event ${row.eventId ?? "unavailable"}. Warning payloads are intentionally omitted; this does not by itself establish export failure.`;
  if (column === "outcome" && row[column] === "network-failure")
    return `The browser fetch failed before an HTTP response was available. Possible causes include connection, DNS or TLS problems, a blocked request, or CORS. This telemetry does not identify which cause occurred.${row.route ? ` Route: ${row.route}.` : ""}`;
  if (column === "outcome" && row[column] === "graphql-error")
    return "The HTTP request succeeded, but the GraphQL response contained an errors array. Private response/error text is not collected.";
  if (column === "httpStatus" && row[column] == null && row.outcome === "network-failure")
    return "No HTTP status was available because the browser fetch failed before a response could be read.";
  if (column === "outcome" && row.httpStatus)
    return `The browser reported HTTP ${row.httpStatus}${row.route ? ` for ${row.route}` : ""}. Private response/error text is not collected. ${context}`;
  if (column === "parentSpanId" && !row[column])
    return "No parent span was reported. This can be a root span or a missing parent; it is not necessarily a failed request.";
  if (source.id === "browser" && /^(p75|metric)$/.test(column) && !row.metric)
    return "This is an outcome event, not a numeric Web Vital measurement; this field is not applicable.";
  if (column === "configuredLimit" && row[column] == null)
    return "No comparable configured limit was supplied for this metric. Headroom and health cannot be inferred.";
  if (/^capture|reasoningSummaryStatus$/.test(column) && !row[column])
    return "No supported captured content or reasoning-summary status was reported for this span. Rich capture is off by default.";
  return context || (row[column] != null && row[column] !== ""
    ? `Observed ${label(column)}. Values are rounded for display; data availability does not prove application health.`
    : `No ${label(column)} measurement or detail was reported for this field. Missing data is not zero and does not prove health.`);
}

function MonitoringCell({ column, row, source }: { column: string; row: MonitoringSource["rows"][number]; source: MonitoringSource }) {
  const value = row[column];
  const reason = cellReason(column, row, source);
  if (value == null || value === "" || (typeof value === "number" && !Number.isFinite(value)))
    return <Explanation reason={reason}><span className="text-primary">Unavailable</span></Explanation>;
  if (typeof value === "boolean")
    return <StatusBadge value={String(value)} reason={value ? "The observed operation reported success." : "The observed operation reported failure. Private error text is not collected."} />;
  if (typeof value === "number") {
    let severity: keyof typeof TONES = "neutral";
    let explanation = reason;
    if (/failures|observedFailures/.test(column)) severity = value > 0 ? "bad" : "good";
    if (column === "unknownUsage") severity = value > 0 ? "warning" : "good";
    if (column === "httpStatus") severity = value === 429 ? "warning" : value >= 400 ? "bad" : value < 300 ? "good" : "neutral";
    if (column === "approximateMessages" && value > 0) severity = String(row.queue).endsWith("-poison") ? "bad" : "warning";
    if (row.unit === "percent" && typeof row.configuredLimit === "number" && row.configuredLimit > 0
        && /^(maximum|averageOfReportedPoints)$/.test(column)) {
      severity = value >= row.configuredLimit ? "bad" : value >= row.configuredLimit * 0.8 ? "warning" : "good";
      explanation = `Observed ${formatNumber(value)}% against a configured ${formatNumber(row.configuredLimit)}% limit. Orange indicates at least 80% of that limit; red indicates the limit was reached.`;
    }
    const content = <span className={severity === "neutral" ? "" : `rounded px-1 ${TONES[severity]}`}>{formatNumber(value)}</span>;
    return explanation !== reason ? <Explanation reason={explanation}>{content}</Explanation> : content;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return <time dateTime={value}>{formatDate(value)}</time>;
  if (/^(status|availability|outcome|signal)$/.test(column))
    return <StatusBadge value={value} reason={reason} />;
  if (/^(resultCode|httpStatus)$/.test(column) && /^\d{3}$/.test(value)) {
    const code = Number(value);
    return <span className={TONES[code === 429 ? "warning" : code >= 400 ? "bad" : code < 300 ? "good" : "neutral"]}>{value}</span>;
  }
  return value;
}

export function MonitoringSourcePanel({ source, title, note, selectTrace, now = Date.now() }: {
  source?: MonitoringSource; title: string; note: string; selectTrace?: (id: string) => void; now?: number;
}) {
  const columns = [...new Set(source?.rows.flatMap(row => Object.keys(row)) ?? [])];
  const latencyRows = source?.id === "services"
    ? source.rows.filter(row => ["p50Ms", "p95Ms", "p99Ms"].some(key => typeof row[key] === "number"))
    : [];
  return <Card>
    <CardHeader><CardTitle>{title}</CardTitle><p className="text-sm text-muted-foreground">{note}</p></CardHeader>
    <CardContent>
      <div className="flex gap-3 items-center mb-3">
        <StatusBadge value={source?.status ?? "unavailable"} reason={source?.reason || "This status describes data availability, not application health."} />
        {source && <span className="text-sm"><Freshness asOf={source.asOf} now={now} /></span>}
      </div>
      {source?.reason && <p role="status" className={cn("mb-3 text-sm", source.status === "available" ? "text-muted-foreground" : source.status === "unavailable" || source.status === "forbidden" ? "text-destructive" : "text-primary")}>{source.reason}</p>}
      {source?.id === "services" && <p className="text-sm mb-3">Observed request samples and sample-weighted estimates are distinct. Percentiles describe ingested spans; failure counts are not guaranteed unsampled totals.</p>}
      {source?.id === "resources" && <p className="text-sm mb-3">Container CPU/memory configured limits are per replica; reported metric rollups may cover multiple replicas or revisions. Raw observations and limits are shown separately, not divided into a fabricated pressure percentage.</p>}
      {latencyRows.length > 0 && <div className="h-64 mb-4" aria-label="Observed service latency percentiles">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={latencyRows}>
          <XAxis dataKey="service" /><YAxis unit="ms" tickFormatter={formatNumber} /><ChartTooltip formatter={value => typeof value === "number" ? formatNumber(value) : String(value)} /><Legend />
          <Bar dataKey="p50Ms" name="p50 ms" fill="hsl(var(--doodle-green))" /><Bar dataKey="p95Ms" name="p95 ms" fill="hsl(var(--primary))" /><Bar dataKey="p99Ms" name="p99 ms" fill="hsl(var(--destructive))" />
        </BarChart></ResponsiveContainer>
      </div>}
      {!source || source.rows.length === 0
        ? <p>{source?.id === "monitoringHealth" && source.status === "no-data"
          ? "No SDK/exporter warnings or daily-cap events were observed in the last 24 hours. This is not a heartbeat or proof of exporter health."
          : source?.status === "no-data" || source?.status === "available"
          ? "No observed data in this range. This is not a healthy result."
          : "This source is unavailable. No zero metrics have been substituted."}</p>
        : <div className="overflow-x-auto"><table className="w-full text-sm text-left">
          <thead><tr>{columns.map(column => <th key={column} className="p-2">{label(column)}</th>)}</tr></thead>
          <tbody>{source.rows.map((row, index) => <tr key={index} className="border-t">
            {columns.map(column => <td key={column} className="p-2 break-words max-w-md">
              {selectTrace && /^(traceId|operation_Id)$/i.test(column) && /^[a-f0-9]{32}$/i.test(String(row[column]))
                ? <a className="underline text-doodle-blue" href="#trace-detail" onClick={event => { event.preventDefault(); selectTrace(String(row[column])); }}>{String(row[column])}</a>
                : source && <MonitoringCell column={column} row={row} source={source} />}
            </td>)}
          </tr>)}</tbody>
        </table></div>}
    </CardContent>
  </Card>;
}

function CaptureControls({ data, canWrite, loading, error, snapshotNow }: { data?: CaptureStatus; canWrite: boolean; loading: boolean; error: Error | null; snapshotNow: number }) {
  const queryClient = useQueryClient();
  const [scopeType, setScopeType] = useState<"session" | "job">("session");
  const [scopeId, setScopeId] = useState("");
  const validScope = scopeType === "job" ? !!scopeId.trim() : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scopeId.trim());
  const [acknowledged, setAcknowledged] = useState(false);
  const [now, setNow] = useState(Date.now());
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["monitoring", "capture"] });
  const start = useMutation({ mutationFn: () => monitoringService.startCapture(scopeType, scopeId.trim()), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: monitoringService.stopCapture, onSuccess: invalidate });
  // Display-only clock. Expiry and admission are enforced server-side even with this page closed.
  useEffect(() => {
    if (!data?.captures.some(grant => grant.status === "active")) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data]);
  return <Card><CardHeader><CardTitle>Temporary rich capture — default off</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>Metadata monitoring continues normally. Rich capture is limited to one selected session or job, 15 minutes and 100 root operations. Child spans share admission.</p>
    <p className="text-sm text-primary">Capture increases telemetry volume and may include redacted content. Stop prevents future capture, not deletion of already ingested telemetry. Provider-managed tracing is independent. Only supported reasoning summaries may be available; encrypted or private reasoning is never shown.</p>
    {loading && <TableSkeleton rows={2} cols={4} />}
    {error && <p role="alert" className="text-destructive">Capture status unavailable: {error.message} No assumption about active grants is safe.</p>}
    {data && <><p className="text-sm">{data.notice} <Freshness asOf={data.asOf} now={snapshotNow} /></p>
      {!data.captures.length && <p>No capture grants reported by the server.</p>}
      <ul className="space-y-3">{data.captures.map(grant => {
        const seconds = Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - now) / 1000));
        const active = grant.status === "active" && seconds > 0 && grant.rootOperations < grant.maxRootOperations;
        return <li key={grant.id} className="border rounded p-3 flex flex-wrap gap-3 items-center">
          <span>{grant.scopeType}: {grant.scopeId}</span>
          <StatusBadge value={grant.status === "active" && !active ? (seconds === 0 ? "expired" : "exhausted") : grant.status} reason="Capture admission and expiry are enforced by the server. The countdown is display-only." />
          <span>{formatNumber(grant.rootOperations)}/{formatNumber(grant.maxRootOperations)} root operations</span>
          <span>{active ? `${Math.floor(seconds / 60)}m ${seconds % 60}s remaining` : `Expires ${formatDate(grant.expiresAt)}`}</span>
          {canWrite && grant.status === "active" && <Button variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(grant.id)}>Stop capture</Button>}
        </li>;
      })}</ul>
    </>}
    {canWrite && <form onSubmit={event => { event.preventDefault(); if (validScope && acknowledged) start.mutate(); }} className="space-y-3">
      <label className="block">Capture scope <select aria-label="Capture scope" className="border rounded p-2 ml-2" value={scopeType} onChange={event => {
        const next = event.target.value as "session" | "job";
        setScopeType(next);
        setScopeId("");
        setAcknowledged(false);
      }}><option value="session">Session</option><option value="job">Job</option></select></label>
      <p className="text-sm">{scopeType === "session"
        ? "Use the server-issued monitoring session GUID shown by an owned chat. It identifies that conversation, not a caller SubjectId or browser-tab ID. The server verifies stored ownership before admission; this ID alone grants no access."
        : "Rich job capture is supported only for persisted manufacturing agent runs, using the exact canonical RunId. It captures the application request and parsed hosted findings/actions output, not internal hosted tool traces, hidden reasoning or provider-managed content. Other job grants remain metadata-only; creating a grant does not prove captured content."}</p>
      <label className="block">Session or job ID<Input value={scopeId} onChange={event => setScopeId(event.target.value)} maxLength={128} placeholder="Exact server-side scope ID" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I understand the privacy, retention and telemetry cost warning.</label>
      <Button type="submit" disabled={!data || !!error || !validScope || !acknowledged || start.isPending || stop.isPending}>Start 15-minute capture</Button>
    </form>}
    {(start.error || stop.error) && <p role="alert" className="text-destructive">{(start.error || stop.error)?.message}</p>}
  </CardContent></Card>;
}

function MonitoringDashboard() {
  const canWrite = useCan("monitoring.write");
  const [range, setRange] = useState<MonitoringRange>("1h");
  const [serviceFilter, setServiceFilter] = useState("");
  const [traceInput, setTraceInput] = useState("");
  const [traceId, setTraceId] = useState("");
  const [traceValidation, setTraceValidation] = useState("");
  const [now, setNow] = useState(Date.now());
  const traceDetailRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  // Display-only freshness clock; this never invalidates queries or makes network calls.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const snapshotUpdates = subscribeLiveUpdates(GROUPS, async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["monitoring", "summary"] }, { cancelRefetch: false }),
        queryClient.invalidateQueries({ queryKey: ["monitoring", "trace"] }, { cancelRefetch: false }),
      ]);
    }, update => update.event !== "monitoring-capture-changed", false);
    const captureUpdates = subscribeLiveUpdates(["utilities"], () =>
      queryClient.invalidateQueries({ queryKey: ["monitoring", "capture"] }, { cancelRefetch: false }),
    update => update.event === "monitoring-capture-changed", false);
    return () => { snapshotUpdates(); captureUpdates(); };
  }, [queryClient]);
  const summary = useQuery({ queryKey: ["monitoring", "summary", range], queryFn: ({ signal }) => monitoringService.summary(range, signal), staleTime: 60_000, retry: false });
  const captures = useQuery({ queryKey: ["monitoring", "capture"], queryFn: ({ signal }) => monitoringService.captures(signal), staleTime: 60_000, retry: false });
  const trace = useQuery({ queryKey: ["monitoring", "trace", traceId], queryFn: ({ signal }) => monitoringService.trace(traceId, signal), enabled: !!traceId, staleTime: 60_000, retry: false });
  const selectTrace = (id: string) => {
    setTraceInput(id); setTraceId(id); setTraceValidation("");
    traceDetailRef.current?.focus({ preventScroll: true });
    traceDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return <TooltipProvider delayDuration={150}><div className="space-y-6">
    <header><h1 className="text-3xl font-bold">Application monitoring</h1><p>Observed demo telemetry — not a liveness or production health promise.</p></header>
    <div className="flex flex-wrap items-center gap-4">
      <label>Lookback <select aria-label="Lookback" className="border rounded p-2 ml-2" value={range} onChange={event => setRange(event.target.value as MonitoringRange)}>{monitoringRanges.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Service filter <Input className="inline-block w-56" aria-label="Service filter" value={serviceFilter} onChange={event => setServiceFilter(event.target.value)} placeholder="Filter observed source rows" /></label>
      {summary.isFetching && <span role="status">Loading monitoring snapshot…</span>}
    </div>
    <p className="text-sm text-muted-foreground">Application changes invalidate this view through the existing live connection. Azure ingestion is delayed; an event does not prove ingestion completion. Window focus, reconnection and filter/load changes recover reads. No periodic polling.</p>
    <p className="text-sm"><span className="text-doodle-green">Green: available data / successful outcomes</span> · <span className="text-primary">Orange: warnings, missing measurements or pressure at least 80% of a comparable limit</span> · <span className="text-destructive">Red: failures or a comparable limit reached</span>. Availability alone does not prove health; latency has no invented threshold.</p>
    {summary.isPending && <KpiSkeleton count={4} />}
    {summary.error && <p role="alert" className="text-destructive">{summary.error.message} {summary.data ? "The last snapshot is stale; retained below." : "No telemetry snapshot is available."}</p>}
    {summary.data && <>
      <div role="status"><StatusBadge value={summary.error ? "stale" : summary.data.status} reason={summary.data.ingestionNote} /> <Freshness asOf={summary.data.asOf} now={now} /> · {summary.data.range}<p>{summary.data.ingestionNote}</p></div>
      <div className="space-y-5">{PANELS.map(([id, title, note]) => {
        const source = summary.data.sources.find(value => value.id === id);
        const filtered = source && serviceFilter.trim() && source.rows.some(row => Object.keys(row).some(key => /role|service|agent/i.test(key)))
          ? { ...source, rows: source.rows.filter(row => Object.entries(row).some(([key, value]) => /role|service|agent/i.test(key) && String(value ?? "").toLowerCase().includes(serviceFilter.toLowerCase()))) }
          : source;
        return <MonitoringSourcePanel key={id} source={filtered} title={title} note={serviceFilter && source && !filtered?.rows.length ? `${note} No rows match this filter.` : note} selectTrace={id === "recentTraces" ? selectTrace : undefined} now={now} />;
      })}</div>
      <nav aria-label="Operator telemetry tools" className="flex flex-wrap gap-4">
        {Object.entries(summary.data.links).filter(([, url]) => {
          try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password; } catch { return false; }
        }).map(([name, url]) => <a className="underline" key={name} href={url} target="_blank" rel="noopener noreferrer">{name === "applicationInsights" ? "Application Insights (map, transaction search, Live Metrics)" : label(name)}</a>)}
      </nav>
      <p className="text-sm">Azure portal/workbook/Grafana links require your separate Entra login and resource RBAC. This admin session grants no Azure portal access.</p>
    </>}
    <Card id="trace-detail" ref={traceDetailRef} tabIndex={-1} className="scroll-mt-32"><CardHeader><CardTitle>Trace detail</CardTitle></CardHeader><CardContent>
      <form className="flex gap-3 mb-4" onSubmit={event => {
        event.preventDefault();
        if (!/^[a-f0-9]{32}$/i.test(traceInput.trim()) || /^0{32}$/.test(traceInput.trim())) { setTraceValidation("Enter a nonzero 32-character hexadecimal trace ID."); return; }
        selectTrace(traceInput.trim());
      }}><Input aria-label="Trace ID" value={traceInput} maxLength={32} onChange={event => setTraceInput(event.target.value)} placeholder="W3C trace ID" /><Button type="submit">Inspect trace</Button></form>
      {traceValidation && <p role="alert" className="text-destructive">{traceValidation}</p>}
      {!traceId && <p>Select a recent trace or enter its ID. Only observed, sanitized spans are available.</p>}
      {trace.isFetching && <TableSkeleton rows={4} cols={5} />}
      {trace.error && <p role="alert" className="text-destructive">{trace.error.message} {trace.data && "Retained trace detail may be stale."}</p>}
      {trace.data && <MonitoringSourcePanel source={trace.data.source} title={`Trace ${trace.data.traceId}`} note={`Status: ${trace.data.status}. ${formatAge(trace.data.asOf, now)}. Missing spans and unsupported reasoning summaries are unavailable, not fabricated.`} now={now} />}
      {trace.data && <section className="mt-4 space-y-3" aria-label="Authorized rich content">
        <h3 className="font-semibold">Selected captured content</h3>
        {!trace.data.richContent?.some(span => Object.keys(span.fields).length)
          ? <p>Rich content and supported reasoning summaries are unavailable for this trace.</p>
          : trace.data.richContent.map(span => <div key={span.spanId} className="space-y-2"><h4>Captured span {span.spanId}</h4>
            {Object.entries(span.fields).map(([field, content]) => <details key={field} className="border rounded p-3"><summary>{label(field)} · {formatNumber(content.originalBytes)} original bytes {content.truncated && "· truncated"} {content.omitted && "· omitted"}</summary>
              <pre className="whitespace-pre-wrap break-words text-sm mt-2">{content.omitted || content.text == null ? "Unavailable or omitted by server policy." : content.text}</pre>
            </details>)}</div>)}
      </section>}
    </CardContent></Card>
    <CaptureControls data={captures.data} canWrite={canWrite} loading={captures.isPending} error={captures.error} snapshotNow={now} />
  </div></TooltipProvider>;
}

export default function MonitoringPage() {
  const { user } = useAuth();
  const canRead = useCan("monitoring.read");
  return <div className="min-h-screen flex flex-col"><AdminHeader /><main className="container mx-auto p-6 flex-1">
    {user?.appRole === "executive-admin" && canRead
      ? <MonitoringDashboard />
      : <p role="alert">Monitoring requires executive-admin and monitoring.read access.</p>}
  </main><Footer /></div>;
}
