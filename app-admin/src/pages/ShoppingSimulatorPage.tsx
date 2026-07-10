import React from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  Activity,
  Users,
  UserPlus,
  Trash2,
  ShoppingCart,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import AdminHeader from "@/components/AdminHeader";
import {
  getShoppingSimulatorStatus,
  startShoppingSimulator,
  stopShoppingSimulator,
  clearShoppingSimulatorQueue,
  getShoppingSimulatorResults,
  type ShoppingSimulatorStatus,
  type SimulationOrderResult,
} from "@/services/utilityService";

const POLL_INTERVAL_MS = 15_000;

const DEFAULT_STATUS: ShoppingSimulatorStatus = {
  isRunning: false,
  ordersPerMinute: 1,
  existingCustomerPercentage: 30,
  startedAt: null,
  totalQueued: 0,
  newCustomerQueued: 0,
  existingCustomerQueued: 0,
  queueDepth: 0,
};

function rateLabel(opm: number): string {
  if (opm === 1) return "1 order / min  (gentle)";
  if (opm <= 5) return `${opm} orders / min  (light)`;
  if (opm <= 20) return `${opm} orders / min  (moderate)`;
  if (opm <= 45) return `${opm} orders / min  (heavy)`;
  if (opm < 60) return `${opm} orders / min  (stress)`;
  return "60 orders / min  ≈ 1 / sec  (max stress)";
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function ShoppingSimulatorPage() {
  const [status, setStatus] =
    React.useState<ShoppingSimulatorStatus>(DEFAULT_STATUS);
  const [loading, setLoading] = React.useState(true);
  const [actionPending, setActionPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<SimulationOrderResult[]>([]);

  // Editable config — only applied on Start; locked while running
  const [rateOpm, setRateOpm] = React.useState(1);
  const [existingPct, setExistingPct] = React.useState(30);

  // ── Fetch status ────────────────────────────────────────────────────────

  const fetchStatus = React.useCallback(async () => {
    try {
      const s = await getShoppingSimulatorStatus();
      setStatus(s);
      setError(null);
      // Keep sliders in sync with actual config when stopped
      if (!s.isRunning) {
        setRateOpm(s.ordersPerMinute);
        setExistingPct(s.existingCustomerPercentage);
      }
      // Fetch recent results when running or queue still processing
      if (s.isRunning || s.queueDepth > 0 || s.totalQueued > 0) {
        const r = await getShoppingSimulatorResults(20);
        setResults(r);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleStart = async () => {
    setActionPending(true);
    setError(null);
    try {
      const s = await startShoppingSimulator({
        ordersPerMinute: rateOpm,
        existingCustomerPercentage: existingPct,
      });
      setStatus(s);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start simulator",
      );
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    setError(null);
    try {
      const s = await stopShoppingSimulator();
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop simulator");
    } finally {
      setActionPending(false);
    }
  };

  const handleClearQueue = async () => {
    setActionPending(true);
    setError(null);
    try {
      const s = await clearShoppingSimulatorQueue();
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear queue");
    } finally {
      setActionPending(false);
    }
  };

  // ── Derived values ──────────────────────────────────────────────────────

  const total = status.totalQueued;
  const newPct =
    total > 0 ? Math.round((status.newCustomerQueued / total) * 100) : 0;
  const existingPct2 = total > 0 ? 100 - newPct : 0;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-doodle-bg">
      <AdminHeader />

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        {/* ── Page header ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3 mb-8">
          <div className="doodle-border-light p-2">
            <Bot className="w-7 h-7 text-doodle-text" />
          </div>
          <div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text">
              Shopping Simulator
            </h1>
            <p className="font-doodle text-sm text-doodle-text/60 mt-0.5">
              Continuously places AI-generated orders to simulate customer
              activity
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {loading ? (
              <Badge variant="outline" className="font-doodle animate-pulse">
                Loading…
              </Badge>
            ) : status.isRunning ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <Badge className="font-doodle bg-green-500 hover:bg-green-500 text-white border-0">
                  Running
                </Badge>
              </span>
            ) : (
              <Badge
                variant="outline"
                className="font-doodle text-doodle-text/60"
              >
                Stopped
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="doodle-button p-1.5"
              onClick={fetchStatus}
              disabled={loading || actionPending}
              title="Refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>

        {/* ── Error banner ─────────────────────────────────────────── */}
        {error && (
          <div className="mb-6 doodle-card border-doodle-accent p-3">
            <p className="font-doodle text-sm text-doodle-accent">{error}</p>
          </div>
        )}

        {/* ── Configuration card ───────────────────────────────────── */}
        <Card className="doodle-card mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Configuration
              {status.isRunning && (
                <Badge
                  variant="outline"
                  className="font-doodle text-xs ml-auto text-doodle-text/50"
                >
                  Locked while running
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Orders per minute slider */}
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <Label className="font-doodle font-bold text-doodle-text">
                  Injection Rate
                </Label>
                <span className="font-doodle text-sm text-doodle-accent font-semibold">
                  {rateLabel(rateOpm)}
                </span>
              </div>
              <Slider
                min={1}
                max={60}
                step={1}
                value={[rateOpm]}
                onValueChange={([v]) => setRateOpm(v)}
                disabled={status.isRunning || actionPending}
                className="w-full"
              />
              <div className="flex justify-between">
                <span className="font-doodle text-xs text-doodle-text/50">
                  1/min
                </span>
                <span className="font-doodle text-xs text-doodle-text/50">
                  60/min ≈ 1/sec
                </span>
              </div>
            </div>

            {/* Existing customer % slider */}
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <Label className="font-doodle font-bold text-doodle-text">
                  Existing Customer Mix
                </Label>
                <span className="font-doodle text-sm text-doodle-accent font-semibold">
                  {existingPct}% existing · {100 - existingPct}% new
                </span>
              </div>
              <Slider
                min={0}
                max={100}
                step={5}
                value={[existingPct]}
                onValueChange={([v]) => setExistingPct(v)}
                disabled={status.isRunning || actionPending}
                className="w-full"
              />
              <div className="flex justify-between">
                <span className="font-doodle text-xs text-doodle-text/50">
                  All new customers
                </span>
                <span className="font-doodle text-xs text-doodle-text/50">
                  All existing customers
                </span>
              </div>
            </div>

            {/* Start / Stop button */}
            <div className="pt-2">
              {status.isRunning ? (
                <Button
                  onClick={handleStop}
                  disabled={actionPending}
                  className="doodle-button doodle-button-danger w-full flex items-center gap-2 justify-center py-3"
                >
                  {actionPending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                  <span className="font-doodle font-bold">
                    {actionPending ? "Stopping…" : "Stop Simulator"}
                  </span>
                </Button>
              ) : (
                <Button
                  onClick={handleStart}
                  disabled={actionPending}
                  className="doodle-button doodle-button-primary w-full flex items-center gap-2 justify-center py-3"
                >
                  {actionPending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  <span className="font-doodle font-bold">
                    {actionPending ? "Starting…" : "Start Simulator"}
                  </span>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Live stats card (shown when running or orders still pending) ── */}
        {(status.isRunning || status.queueDepth > 0) && (
          <Card className="doodle-card mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
                <Activity className="w-5 h-5" />
                Live Stats
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Queue depth + started at */}
              <div className="grid grid-cols-2 gap-4">
                <div className="doodle-card p-3 text-center">
                  <p className="font-doodle text-2xl font-bold text-doodle-text">
                    {total.toLocaleString()}
                  </p>
                  <p className="font-doodle text-xs text-doodle-text/60 mt-1">
                    Queued This Run
                  </p>
                </div>
                <div className="doodle-card p-3 text-center">
                  <p className="font-doodle text-2xl font-bold text-doodle-accent">
                    {status.queueDepth >= 0
                      ? status.queueDepth.toLocaleString()
                      : "—"}
                  </p>
                  <p className="font-doodle text-xs text-doodle-text/60 mt-1">
                    Total Queued
                  </p>
                </div>
              </div>

              {/* Clear queue button — only shown when stopped with pending messages */}
              {!status.isRunning && status.queueDepth > 0 && (
                <div className="pt-1">
                  <Button
                    onClick={handleClearQueue}
                    disabled={actionPending}
                    variant="outline"
                    className="doodle-button doodle-button-danger w-full flex items-center gap-2 justify-center py-2"
                  >
                    {actionPending ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                    <span className="font-doodle font-bold text-sm">
                      {actionPending
                        ? "Clearing…"
                        : `Clear Queue (${status.queueDepth.toLocaleString()} pending)`}
                    </span>
                  </Button>
                </div>
              )}

              {/* Persona breakdown */}
              {total > 0 && (
                <div>
                  <p className="font-doodle text-sm font-bold text-doodle-text mb-2">
                    Persona Mix
                  </p>

                  {/* Visual split bar */}
                  <div className="flex h-4 rounded overflow-hidden border-2 border-doodle-text mb-2">
                    <div
                      className="bg-doodle-green transition-all duration-500"
                      style={{ width: `${newPct}%` }}
                      title={`New customers: ${newPct}%`}
                    />
                    <div
                      className="bg-doodle-accent transition-all duration-500"
                      style={{ width: `${existingPct2}%` }}
                      title={`Existing customers: ${existingPct2}%`}
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-sm bg-doodle-green inline-block border border-doodle-text" />
                      <UserPlus className="w-3.5 h-3.5 text-doodle-text" />
                      <span className="font-doodle text-xs text-doodle-text">
                        New{" "}
                        <strong>
                          {status.newCustomerQueued.toLocaleString()}
                        </strong>
                        <span className="text-doodle-text/50 ml-1">
                          ({newPct}%)
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-sm bg-doodle-accent inline-block border border-doodle-text" />
                      <Users className="w-3.5 h-3.5 text-doodle-text" />
                      <span className="font-doodle text-xs text-doodle-text">
                        Existing{" "}
                        <strong>
                          {status.existingCustomerQueued.toLocaleString()}
                        </strong>
                        <span className="text-doodle-text/50 ml-1">
                          ({existingPct2}%)
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Started at */}
              {status.startedAt && (
                <p className="font-doodle text-xs text-doodle-text/50">
                  Last started: {formatTimestamp(status.startedAt)}
                  {status.isRunning && (
                    <span className="ml-2 text-doodle-accent font-semibold">
                      · {status.ordersPerMinute} order
                      {status.ordersPerMinute === 1 ? "" : "s"}/min
                    </span>
                  )}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Recent Orders feed ──────────────────────────────────────── */}
        {results.length > 0 && (
          <Card className="doodle-card mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" />
                Recent Orders
                <Badge
                  variant="outline"
                  className="font-doodle text-xs ml-auto text-doodle-text/50"
                >
                  Last {results.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {results.map((r, i) => (
                  <div
                    key={`${r.salesOrderId}-${i}`}
                    className={`doodle-card p-3 flex items-start gap-3 ${!r.success ? "border-doodle-accent" : ""}`}
                  >
                    {r.success ? (
                      <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-doodle-accent mt-0.5 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      {r.success ? (
                        <>
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <Link
                              to={`/orders?orderId=${r.salesOrderId}`}
                              className="font-doodle text-sm font-bold text-doodle-text hover:text-doodle-accent underline decoration-doodle-accent/30 hover:decoration-doodle-accent transition-colors"
                            >
                              Order #{r.salesOrderId}
                            </Link>
                            {r.customerId ? (
                              <Link
                                to={`/customers?customerId=${r.customerId}`}
                                className="font-doodle text-sm text-doodle-text/70 hover:text-doodle-accent underline decoration-doodle-accent/30 hover:decoration-doodle-accent transition-colors"
                              >
                                {r.customerName}
                              </Link>
                            ) : (
                              <span className="font-doodle text-sm text-doodle-text/70">
                                {r.customerName}
                              </span>
                            )}
                            {r.newCustomerCreated && (
                              <Badge
                                variant="outline"
                                className="font-doodle text-[10px] py-0 px-1"
                              >
                                new
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-baseline gap-3 mt-0.5">
                            <span className="font-doodle text-xs text-doodle-accent font-semibold">
                              ${r.totalDue.toFixed(2)}
                            </span>
                            {r.personaType && (
                              <span className="font-doodle text-xs text-doodle-text/50">
                                {r.personaType}
                              </span>
                            )}
                            <span className="font-doodle text-xs text-doodle-text/40 ml-auto">
                              {new Date(r.completedAt).toLocaleTimeString(
                                undefined,
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                },
                              )}
                            </span>
                          </div>
                          {r.aiReasoning && (
                            <p className="font-doodle text-xs text-doodle-text/50 mt-1 line-clamp-2">
                              {r.aiReasoning}
                            </p>
                          )}
                        </>
                      ) : (
                        <div>
                          <span className="font-doodle text-sm font-bold text-doodle-accent">
                            Failed
                          </span>
                          {r.personaType && (
                            <span className="font-doodle text-xs text-doodle-text/50 ml-2">
                              {r.personaType}
                            </span>
                          )}
                          {r.errorMessage && (
                            <p className="font-doodle text-xs text-doodle-text/60 mt-0.5 line-clamp-2">
                              {r.errorMessage}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Info callout ─────────────────────────────────────────── */}
        <div className="doodle-card p-4 border-l-4 border-l-doodle-text">
          <p className="font-doodle text-sm font-bold text-doodle-text mb-1">
            How it works
          </p>
          <p className="font-doodle text-sm text-doodle-text/70 leading-relaxed">
            The simulator enqueues AI-generated order messages once per minute.
            Each message triggers the <strong>GenerateOrderWithAI</strong>{" "}
            pipeline — a real Foundry agent selects products, creates a customer
            (new or existing), and places a SQL order, which in turn fires the{" "}
            <strong>manufacturing agent</strong> and supply-chain processes.
          </p>
          <p className="font-doodle text-sm text-doodle-text/70 leading-relaxed mt-2">
            At <strong>60 orders/min</strong> the queue fills at ~1 message per
            second. Because AI processing takes several seconds each, the
            backlog grows quickly — ideal for stress-testing inventory depletion
            and manufacturing scale-out.
          </p>
          <p className="font-doodle text-xs text-doodle-text/40 mt-3">
            The global <em>Simulators Reset</em> will also stop this simulator
            and clear all pending messages.
          </p>
        </div>
      </main>
    </div>
  );
}
