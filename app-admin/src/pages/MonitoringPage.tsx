import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { TableSkeleton, KpiSkeleton } from "@/components/LoadingSkeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
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
  ["monitoringHealth", "Monitoring self-diagnostics", "Last observed exporter, ingestion and cap signals. Missing diagnostics are not a healthy result."],
  ["recentTraces", "Recent trace samples", "Sampled traces are not traffic totals. Select a trace to inspect its observed timeline."],
] as const;

function label(key: string) {
  return key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function MonitoringSourcePanel({ source, title, note, selectTrace }: {
  source?: MonitoringSource; title: string; note: string; selectTrace?: (id: string) => void;
}) {
  const columns = [...new Set(source?.rows.flatMap(row => Object.keys(row)) ?? [])];
  const latencyRows = source?.id === "services"
    ? source.rows.filter(row => ["p50Ms", "p95Ms", "p99Ms"].some(key => typeof row[key] === "number"))
    : [];
  return <Card>
    <CardHeader><CardTitle>{title}</CardTitle><p className="text-sm text-muted-foreground">{note}</p></CardHeader>
    <CardContent>
      <div className="flex gap-3 items-center mb-3">
        <Badge variant="outline">{source?.status ?? "unavailable"}</Badge>
        {source && <span className="text-sm">As of {source.asOf}</span>}
      </div>
      {source?.reason && <p role="status" className="mb-3">{source.reason}</p>}
      {source?.id === "services" && <p className="text-sm mb-3">Observed request samples and sample-weighted estimates are distinct. Percentiles describe ingested spans; failure counts are not guaranteed unsampled totals.</p>}
      {source?.id === "resources" && <p className="text-sm mb-3">Container CPU/memory configured limits are per replica; reported metric rollups may cover multiple replicas or revisions. Raw observations and limits are shown separately, not divided into a fabricated pressure percentage.</p>}
      {latencyRows.length > 0 && <div className="h-64 mb-4" aria-label="Observed service latency percentiles">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={latencyRows}>
          <XAxis dataKey="service" /><YAxis unit="ms" /><Tooltip /><Legend />
          <Bar dataKey="p50Ms" name="p50 ms" fill="#2563eb" /><Bar dataKey="p95Ms" name="p95 ms" fill="#d97706" /><Bar dataKey="p99Ms" name="p99 ms" fill="#dc2626" />
        </BarChart></ResponsiveContainer>
      </div>}
      {!source || source.rows.length === 0
        ? <p>{source?.status === "no-data" || source?.status === "available"
          ? "No observed data in this range. This is not a healthy result."
          : "This source is unavailable. No zero metrics have been substituted."}</p>
        : <div className="overflow-x-auto"><table className="w-full text-sm text-left">
          <thead><tr>{columns.map(column => <th key={column} className="p-2">{label(column)}</th>)}</tr></thead>
          <tbody>{source.rows.map((row, index) => <tr key={index} className="border-t">
            {columns.map(column => <td key={column} className="p-2 break-words max-w-md">
              {row[column] == null ? <span className="text-muted-foreground">Unavailable</span>
                : selectTrace && /^(traceId|operation_Id)$/i.test(column) && /^[a-f0-9]{32}$/i.test(String(row[column]))
                  ? <button className="underline" onClick={() => selectTrace(String(row[column]))}>{String(row[column])}</button>
                  : String(row[column])}
            </td>)}
          </tr>)}</tbody>
        </table></div>}
    </CardContent>
  </Card>;
}

function CaptureControls({ data, canWrite, loading, error }: { data?: CaptureStatus; canWrite: boolean; loading: boolean; error: Error | null }) {
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
    <p className="text-sm text-amber-800 dark:text-amber-300">Capture increases telemetry volume and may include redacted content. Stop prevents future capture, not deletion of already ingested telemetry. Provider-managed tracing is independent. Only supported reasoning summaries may be available; encrypted or private reasoning is never shown.</p>
    {loading && <TableSkeleton rows={2} cols={4} />}
    {error && <p role="alert">Capture status unavailable: {error.message} No assumption about active grants is safe.</p>}
    {data && <><p className="text-sm">{data.notice} As of {data.asOf}</p>
      {!data.captures.length && <p>No capture grants reported by the server.</p>}
      <ul className="space-y-3">{data.captures.map(grant => {
        const seconds = Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - now) / 1000));
        const active = grant.status === "active" && seconds > 0 && grant.rootOperations < grant.maxRootOperations;
        return <li key={grant.id} className="border rounded p-3 flex flex-wrap gap-3 items-center">
          <span>{grant.scopeType}: {grant.scopeId}</span>
          <Badge variant="outline">{grant.status === "active" && !active ? (seconds === 0 ? "expiry elapsed" : "operation limit reached") : grant.status}</Badge>
          <span>{grant.rootOperations}/{grant.maxRootOperations} root operations</span>
          <span>{active ? `${Math.floor(seconds / 60)}m ${seconds % 60}s remaining` : `Expires ${grant.expiresAt}`}</span>
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
    {(start.error || stop.error) && <p role="alert">{(start.error || stop.error)?.message}</p>}
  </CardContent></Card>;
}

function MonitoringDashboard() {
  const canWrite = useCan("monitoring.write");
  const [range, setRange] = useState<MonitoringRange>("1h");
  const [serviceFilter, setServiceFilter] = useState("");
  const [traceInput, setTraceInput] = useState("");
  const [traceId, setTraceId] = useState("");
  const [traceValidation, setTraceValidation] = useState("");
  const queryClient = useQueryClient();
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
  const selectTrace = (id: string) => { setTraceInput(id); setTraceId(id); setTraceValidation(""); };
  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold">Application monitoring</h1><p>Observed demo telemetry — not a liveness or production health promise.</p></header>
    <div className="flex flex-wrap items-center gap-4">
      <label>Lookback <select aria-label="Lookback" className="border rounded p-2 ml-2" value={range} onChange={event => setRange(event.target.value as MonitoringRange)}>{monitoringRanges.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Service filter <Input className="inline-block w-56" aria-label="Service filter" value={serviceFilter} onChange={event => setServiceFilter(event.target.value)} placeholder="Filter observed source rows" /></label>
      {summary.isFetching && <span role="status">Loading monitoring snapshot…</span>}
    </div>
    <p className="text-sm text-muted-foreground">Application changes invalidate this view through the existing live connection. Azure ingestion is delayed; an event does not prove ingestion completion. Window focus, reconnection and filter/load changes recover reads. No periodic polling.</p>
    {summary.isPending && <KpiSkeleton count={4} />}
    {summary.error && <p role="alert">{summary.error.message} {summary.data ? "The last snapshot is stale; retained below." : "No telemetry snapshot is available."}</p>}
    {summary.data && <>
      <div role="status"><Badge variant="outline">{summary.error ? "stale" : summary.data.status}</Badge> As of {summary.data.asOf} · {summary.data.range}<p>{summary.data.ingestionNote}</p></div>
      <div className="space-y-5">{PANELS.map(([id, title, note]) => {
        const source = summary.data.sources.find(value => value.id === id);
        const filtered = source && serviceFilter.trim() && source.rows.some(row => Object.keys(row).some(key => /role|service|agent/i.test(key)))
          ? { ...source, rows: source.rows.filter(row => Object.entries(row).some(([key, value]) => /role|service|agent/i.test(key) && String(value ?? "").toLowerCase().includes(serviceFilter.toLowerCase()))) }
          : source;
        return <MonitoringSourcePanel key={id} source={filtered} title={title} note={serviceFilter && source && !filtered?.rows.length ? `${note} No rows match this filter.` : note} selectTrace={id === "recentTraces" ? selectTrace : undefined} />;
      })}</div>
      <nav aria-label="Operator telemetry tools" className="flex flex-wrap gap-4">
        {Object.entries(summary.data.links).filter(([, url]) => {
          try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password; } catch { return false; }
        }).map(([name, url]) => <a className="underline" key={name} href={url} target="_blank" rel="noopener noreferrer">{name === "applicationInsights" ? "Application Insights (map, transaction search, Live Metrics)" : label(name)}</a>)}
      </nav>
      <p className="text-sm">Azure portal/workbook/Grafana links require your separate Entra login and resource RBAC. This admin session grants no Azure portal access.</p>
    </>}
    <Card><CardHeader><CardTitle>Trace detail</CardTitle></CardHeader><CardContent>
      <form className="flex gap-3 mb-4" onSubmit={event => {
        event.preventDefault();
        if (!/^[a-f0-9]{32}$/i.test(traceInput.trim()) || /^0{32}$/.test(traceInput.trim())) { setTraceValidation("Enter a nonzero 32-character hexadecimal trace ID."); return; }
        selectTrace(traceInput.trim());
      }}><Input aria-label="Trace ID" value={traceInput} maxLength={32} onChange={event => setTraceInput(event.target.value)} placeholder="W3C trace ID" /><Button type="submit">Inspect trace</Button></form>
      {traceValidation && <p role="alert">{traceValidation}</p>}
      {!traceId && <p>Select a recent trace or enter its ID. Only observed, sanitized spans are available.</p>}
      {trace.isFetching && <TableSkeleton rows={4} cols={5} />}
      {trace.error && <p role="alert">{trace.error.message} {trace.data && "Retained trace detail may be stale."}</p>}
      {trace.data && <MonitoringSourcePanel source={trace.data.source} title={`Trace ${trace.data.traceId}`} note={`Status: ${trace.data.status}. As of ${trace.data.asOf}. Missing spans and unsupported reasoning summaries are unavailable, not fabricated.`} />}
      {trace.data && <section className="mt-4 space-y-3" aria-label="Authorized rich content">
        <h3 className="font-semibold">Selected captured content</h3>
        {!trace.data.richContent?.some(span => Object.keys(span.fields).length)
          ? <p>Rich content and supported reasoning summaries are unavailable for this trace.</p>
          : trace.data.richContent.map(span => <div key={span.spanId} className="space-y-2"><h4>Captured span {span.spanId}</h4>
            {Object.entries(span.fields).map(([field, content]) => <details key={field} className="border rounded p-3"><summary>{label(field)} · {content.originalBytes} original bytes {content.truncated && "· truncated"} {content.omitted && "· omitted"}</summary>
              <pre className="whitespace-pre-wrap break-words text-sm mt-2">{content.omitted || content.text == null ? "Unavailable or omitted by server policy." : content.text}</pre>
            </details>)}</div>)}
      </section>}
    </CardContent></Card>
    <CaptureControls data={captures.data} canWrite={canWrite} loading={captures.isPending} error={captures.error} />
  </div>;
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
