import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Activity, ArrowLeft, Check, Clock, AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getGraphQLApiUrl, getFunctionsApiUrl } from "@/lib/utils";
import { trackError } from "@/lib/appInsights";
import {
  checkIdsForMode, initialHealthChecks, overallHealth, runHealthChecks,
  type CheckMode, type HealthCheck, type HealthStatus,
} from "@/lib/healthChecks";
import { getWebPubSubStatus, subscribeWebPubSubStatus } from "@/hooks/useWebPubSub";

const statusLabels: Record<HealthStatus, string> = {
  checking: "Checking", healthy: "Passed", unhealthy: "Failed", timeout: "Timeout",
  unknown: "Unknown", running: "Running", configured: "Configured only",
  "not-configured": "Not configured", "not-run": "Not run",
};

const statusColors: Record<HealthStatus, string> = {
  healthy: "border-green-600 bg-green-50 text-green-800",
  unhealthy: "border-red-600 bg-red-50 text-red-800",
  timeout: "border-red-600 bg-red-50 text-red-800",
  checking: "border-amber-600 bg-amber-50 text-amber-800",
  running: "border-amber-600 bg-amber-50 text-amber-800",
  unknown: "border-amber-600 bg-amber-50 text-amber-800",
  "not-configured": "border-amber-600 bg-amber-50 text-amber-800",
  configured: "border-slate-400 bg-slate-100 text-slate-700",
  "not-run": "border-slate-400 bg-slate-100 text-slate-700",
};

const testTypes: Record<CheckMode, {
  label: string; section: string; card: string; badge: string; button: string;
}> = {
  quick: {
    label: "Quick checks", section: "border-sky-300 bg-sky-50/60",
    card: "border-sky-200 border-l-sky-600", badge: "border-sky-600 bg-sky-100 text-sky-900",
    button: "border-sky-700 bg-sky-700 text-white hover:bg-sky-800 hover:text-white",
  },
  capabilities: {
    label: "Capability checks", section: "border-violet-300 bg-violet-50/60",
    card: "border-violet-200 border-l-violet-600", badge: "border-violet-600 bg-violet-100 text-violet-900",
    button: "border-violet-700 bg-violet-700 text-white hover:bg-violet-800 hover:text-white",
  },
  data: {
    label: "Demo readiness", section: "border-teal-300 bg-teal-50/60",
    card: "border-teal-200 border-l-teal-600", badge: "border-teal-600 bg-teal-100 text-teal-900",
    button: "border-teal-700 bg-teal-700 text-white hover:bg-teal-800 hover:text-white",
  },
};

function StatusBadge({ status }: { status: HealthStatus }) {
  return <Badge variant="outline" className={statusColors[status]}>
    {statusLabels[status]}
  </Badge>;
}

function CheckCard({ check, testType }: { check: HealthCheck; testType: CheckMode }) {
  return (
    <Card className={`border-2 border-l-4 ${testTypes[testType].card}`}
      data-test-type={testType} data-testid={`check-${check.id}`}>
      <CardHeader>
        <Badge variant="outline" className={`w-fit ${testTypes[testType].badge}`}>
          {testTypes[testType].label}
        </Badge>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="font-doodle text-lg flex items-center gap-2">
            {check.status === "checking" ? <Clock className="w-5 h-5 animate-spin" />
              : check.status === "healthy" ? <Check className="w-5 h-5 text-green-600" />
              : <AlertCircle className="w-5 h-5 text-muted-foreground" />}
            {check.name}
          </CardTitle>
          <StatusBadge status={check.status} />
        </div>
        {check.endpoint && <CardDescription className="font-mono text-xs break-all">{check.endpoint}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{check.message || "Run this diagnostic when needed."}</p>
        {check.checkedAt && <p className="text-xs text-muted-foreground">
          Checked {new Date(check.checkedAt).toLocaleString()}
          {check.responseTimeMs !== undefined && ` | ${check.responseTimeMs}ms`}
        </p>}
      </CardContent>
    </Card>
  );
}

const sections: Array<{ testType: CheckMode; title: string; description: string }> = [
  { testType: "quick", title: "Quick checks: services and configuration",
    description: "Core service availability plus optional dependency and configuration checks. Only core services determine overall availability; configured-only badges do not prove operation." },
  { testType: "capabilities", title: "Capability checks: functional diagnostics",
    description: "Opt-in search, agent status, catalog, sitemap, and API documentation checks. May incur embedding costs. No chat, autonomous agent, order, email, or receipt is generated." },
  { testType: "data", title: "Demo readiness: seed and image metadata",
    description: "Seed progress and sampled AI photo metadata are separate from service availability. No fixed image-count requirement." },
];

export default function HealthCheckPage() {
  const [checks, setChecks] = useState(initialHealthChecks);
  const [mode, setMode] = useState<CheckMode | null>(null);
  const [runIds, setRunIds] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const sectionRefs = useRef<Partial<Record<CheckMode, HTMLElement>>>({});
  const webSocket = useSyncExternalStore(subscribeWebPubSubStatus, getWebPubSubStatus);

  async function run(nextMode: CheckMode, revealTests = false) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const ids = checkIdsForMode(nextMode);
    setRunIds(ids);
    setMode(nextMode);
    setStartedAt(Date.now());
    setFinishedAt(null);
    setChecks(previous => previous.map(check => ids.includes(check.id)
      ? { ...check, status: "checking", message: undefined, checkedAt: undefined, responseTimeMs: undefined }
      : check));
    if (revealTests) {
      const section = sectionRefs.current[nextMode];
      section?.focus({ preventScroll: true });
      section?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        block: "start",
      });
    }
    await runHealthChecks({
      graphqlUrl: getGraphQLApiUrl(), functionsUrl: getFunctionsApiUrl(),
    }, nextMode, controller.signal, result => {
      if (result.status === "unhealthy" || result.status === "timeout")
        trackError("Health diagnostic failed", new Error(result.message), { checkId: result.id });
      setChecks(previous => previous.map(check => check.id === result.id ? result : check));
    });
    if (!controller.signal.aborted) {
      setFinishedAt(Date.now());
      setMode(null);
    }
  }

  useEffect(() => {
    void run("quick");
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!mode) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mode]);

  const completed = checks.filter(check => runIds.includes(check.id) && check.status !== "checking").length;
  const progress = runIds.length ? completed / runIds.length * 100 : 0;
  const elapsed = startedAt === null ? "0" : (Math.max(0, (finishedAt ?? now) - startedAt) / 1000).toFixed(1);
  const summary = overallHealth(checks);

  return (
    <main className="min-h-screen bg-doodle-bg">
      <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
        <Link to="/" className="inline-flex items-center gap-2 text-sm underline">
          <ArrowLeft className="w-4 h-4" /> Back to shop
        </Link>
        <header>
          <h1 className="font-doodle text-4xl font-bold flex items-center gap-3">
            <Activity className="w-8 h-8" /> System diagnostics
          </h1>
          <p className="mt-3 text-muted-foreground">
            A point-in-time check, not continuous monitoring. Quick checks run on entry.
            Cold starts can take up to 60s; optional functional checks allow 90s.
            Results stay visible until you rerun them. This page never reloads or polls services.
          </p>
        </header>
        <Card className="border-2 border-doodle-text">
          <CardHeader>
            <CardTitle className="font-doodle" aria-live="polite" data-testid="overall-status">
              {summary}
            </CardTitle>
            <CardDescription>
              {mode ? `Running ${mode} diagnostics` : "Latest diagnostic run complete"} | {elapsed}s
              <span className="block">Backend dependency results are cached for up to 60s; each card shows its observation time.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={progress} aria-label="Diagnostic progress"
              aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}
              data-testid="health-check-progress" />
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className={testTypes.quick.button}
                aria-controls="quick-tests" disabled={mode !== null}
                onClick={() => void run("quick", true)}>Run quick checks again</Button>
              <Button variant="outline" className={`h-auto min-h-10 max-w-full whitespace-normal ${testTypes.capabilities.button}`}
                aria-controls="capabilities-tests" disabled={mode !== null}
                onClick={() => void run("capabilities", true)}>Run capability checks (may incur AI cost)</Button>
              <Button variant="outline" className={testTypes.data.button}
                aria-controls="data-tests" disabled={mode !== null}
                onClick={() => void run("data", true)}>Check demo readiness</Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Button colors match test sections and card labels. Result badges: green = passed;
              red = failed/timeout; amber = checking/running/warning; gray = configured only/not run.
            </p>
            <p className="text-sm text-muted-foreground">{completed} / {runIds.length} checks completed in the latest run.</p>
          </CardContent>
        </Card>
        {sections.map(section => (
          <section key={section.testType} id={`${section.testType}-tests`}
            ref={element => { sectionRefs.current[section.testType] = element ?? undefined; }}
            tabIndex={-1} aria-labelledby={`${section.testType}-heading`}
            className={`space-y-4 rounded-lg border-2 p-4 sm:p-6 scroll-mt-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 ${testTypes[section.testType].section}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id={`${section.testType}-heading`} className="font-doodle text-2xl font-bold">{section.title}</h2>
              <Badge variant="outline" className={testTypes[section.testType].badge} aria-live="polite">
                {mode === section.testType ? "Running" : `${checkIdsForMode(section.testType).length} tests`}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{section.description}</p>
            {section.testType === "quick" && (
              <Card data-testid="websocket-status" className={`border-2 border-l-4 ${testTypes.quick.card}`}>
                <CardHeader>
                  <Badge variant="outline" className={`w-fit ${testTypes.quick.badge}`}>Quick checks | Live connection</Badge>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle className="font-doodle text-lg">Browser real-time connection: {webSocket}</CardTitle>
                    <StatusBadge status={webSocket === "connected" ? "healthy" : webSocket === "connecting"
                      ? "checking" : webSocket === "not-configured" ? "not-configured" : "unhealthy"} />
                  </div>
                  <CardDescription>
                    Uses the existing app WebSocket; no additional connection opened.
                    Connected does not prove mutations are publishing events.
                    {webSocket !== "connected" && " Live cache invalidation is unavailable; returning to the tab provides the normal React Query focus-refetch fallback."}
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
            <div className="grid gap-4 md:grid-cols-2" data-testid={`${section.testType}-checks`}>
              {checks.filter(check => checkIdsForMode(section.testType).includes(check.id))
                .map(check => <CheckCard key={check.id} check={check} testType={section.testType} />)}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
