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
  Store,
  Clock,
  Tag,
  ShoppingBag,
  Settings,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  durationHours: 24,
  stopScheduledAt: null,
  noOrderCustomerPercentage: 50,
  abandonedCartPercentage: 10,
  includeConsumerOrders: true,
  includeStoreOrders: true,
  storeOrderPercentage: 20,
  startedAt: null,
  totalQueued: 0,
  newCustomerQueued: 0,
  existingCustomerQueued: 0,
  storeOrderQueued: 0,
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

function formatRemaining(stopAt: string | null): string {
  if (!stopAt) return "";
  const remaining = new Date(stopAt).getTime() - Date.now();
  if (remaining <= 0) return "stopping…";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function durationLabel(h: number): string {
  if (h === 1) return "1 hour";
  if (h <= 12) return `${h} hours`;
  if (h === 24) return "24 hours (1 day)";
  if (h === 48) return "48 hours (2 days)";
  if (h === 72) return "72 hours (3 days — max)";
  return `${h} hours`;
}

function orderTypeBadge(orderType: string | null) {
  switch (orderType) {
    case "b2b-store":
      return (
        <Badge
          variant="outline"
          className="font-doodle text-[10px] py-0 px-1 border-blue-400 text-blue-600"
        >
          B2B
        </Badge>
      );
    case "cart-recovery":
      return (
        <Badge
          variant="outline"
          className="font-doodle text-[10px] py-0 px-1 border-orange-400 text-orange-600"
        >
          cart
        </Badge>
      );
    case "no-order-customer":
      return (
        <Badge
          variant="outline"
          className="font-doodle text-[10px] py-0 px-1 border-purple-400 text-purple-600"
        >
          sale
        </Badge>
      );
    default:
      return null;
  }
}

function formatFailureCode(failureCode: string | null | undefined): string {
  if (!failureCode) return "";
  return failureCode
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
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
  const [durationHours, setDurationHours] = React.useState(24);
  const [noOrderPct, setNoOrderPct] = React.useState(50);
  const [abandonedCartPct, setAbandonedCartPct] = React.useState(10);
  const [includeConsumer, setIncludeConsumer] = React.useState(true);
  const [includeStore, setIncludeStore] = React.useState(true);
  const [storeOrderPct, setStoreOrderPct] = React.useState(20);

  // Track previous running state so we only sync sliders on initial load
  // or when the simulator transitions from running → stopped
  const prevRunningRef = React.useRef<boolean | null>(null);

  // ── Fetch status ────────────────────────────────────────────────────────

  const fetchStatus = React.useCallback(async () => {
    try {
      const s = await getShoppingSimulatorStatus();
      setStatus(s);
      setError(null);
      // Sync sliders only on initial load or running→stopped transition
      const wasRunning = prevRunningRef.current;
      const isFirstLoad = wasRunning === null;
      const justStopped = wasRunning === true && !s.isRunning;
      prevRunningRef.current = s.isRunning;
      if (!s.isRunning && (isFirstLoad || justStopped)) {
        setRateOpm(s.ordersPerMinute);
        setExistingPct(s.existingCustomerPercentage);
        setDurationHours(s.durationHours);
        setNoOrderPct(s.noOrderCustomerPercentage);
        setAbandonedCartPct(s.abandonedCartPercentage);
        setIncludeConsumer(s.includeConsumerOrders);
        setIncludeStore(s.includeStoreOrders);
        setStoreOrderPct(s.storeOrderPercentage);
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
        durationHours,
        noOrderCustomerPercentage: noOrderPct,
        abandonedCartPercentage: abandonedCartPct,
        includeConsumerOrders: includeConsumer,
        includeStoreOrders: includeStore,
        storeOrderPercentage: storeOrderPct,
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
  const consumerTotal =
    status.newCustomerQueued + status.existingCustomerQueued;
  const newPct =
    total > 0 ? Math.round((status.newCustomerQueued / total) * 100) : 0;
  const existingPct2 =
    total > 0 ? Math.round((status.existingCustomerQueued / total) * 100) : 0;
  const storePct =
    total > 0 ? Math.round((status.storeOrderQueued / total) * 100) : 0;

  // Validation: at least one order type must be enabled
  const canStart = includeConsumer || includeStore;

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
            <Link
              to="/order-pipeline"
              className="doodle-button p-1.5 inline-flex items-center"
              title="Order Pipeline Settings"
            >
              <Settings className="w-4 h-4" />
            </Link>
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
            {/* Duration slider */}
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <Label className="font-doodle font-bold text-doodle-text flex items-center gap-1.5">
                  <Clock className="w-4 h-4" />
                  Duration
                </Label>
                <span className="font-doodle text-sm text-doodle-accent font-semibold">
                  {durationLabel(durationHours)}
                </span>
              </div>
              <Slider
                min={1}
                max={72}
                step={1}
                value={[durationHours]}
                onValueChange={([v]) => setDurationHours(v)}
                disabled={status.isRunning || actionPending}
                className="w-full"
              />
              <div className="flex justify-between">
                <span className="font-doodle text-xs text-doodle-text/50">
                  1h
                </span>
                <span className="font-doodle text-xs text-doodle-text/50">
                  72h (3 days)
                </span>
              </div>
              {status.isRunning && status.stopScheduledAt && (
                <p className="font-doodle text-xs text-doodle-accent font-semibold">
                  ⏱ {formatRemaining(status.stopScheduledAt)} — auto-stops at{" "}
                  {formatTimestamp(status.stopScheduledAt)}
                </p>
              )}
            </div>

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

            {/* ── Order Type Toggles ─────────────────────────────────── */}
            <div className="space-y-3 border-t border-doodle-text/10 pt-4">
              <Label className="font-doodle font-bold text-doodle-text">
                Order Types
              </Label>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4 text-doodle-text/70" />
                  <span className="font-doodle text-sm text-doodle-text">
                    Consumer (B2C) orders
                  </span>
                </div>
                <Switch
                  checked={includeConsumer}
                  onCheckedChange={(v) => {
                    if (!v && !includeStore) return; // at least one must be on
                    setIncludeConsumer(v);
                  }}
                  disabled={status.isRunning || actionPending}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Store className="w-4 h-4 text-doodle-text/70" />
                  <span className="font-doodle text-sm text-doodle-text">
                    B2B store orders
                  </span>
                </div>
                <Switch
                  checked={includeStore}
                  onCheckedChange={(v) => {
                    if (!v && !includeConsumer) return;
                    setIncludeStore(v);
                  }}
                  disabled={status.isRunning || actionPending}
                />
              </div>
              {includeConsumer && includeStore && (
                <div className="space-y-2 ml-6">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-xs text-doodle-text/70">
                      B2B store order share
                    </span>
                    <span className="font-doodle text-xs text-doodle-accent font-semibold">
                      {storeOrderPct}% store · {100 - storeOrderPct}% consumer
                    </span>
                  </div>
                  <Slider
                    min={5}
                    max={50}
                    step={5}
                    value={[storeOrderPct]}
                    onValueChange={([v]) => setStoreOrderPct(v)}
                    disabled={status.isRunning || actionPending}
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* ── Consumer Mix (only when consumer orders enabled) ──── */}
            {includeConsumer && (
              <div className="space-y-4 border-t border-doodle-text/10 pt-4">
                <Label className="font-doodle font-bold text-doodle-text">
                  Consumer Order Mix
                </Label>

                {/* Existing customer % slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-sm text-doodle-text">
                      Existing vs New Customers
                    </span>
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

                {/* No-order customer % slider (within new-customer slots) */}
                <div className="space-y-2 ml-4 border-l-2 border-doodle-text/10 pl-4">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-xs text-doodle-text/70 flex items-center gap-1">
                      <Tag className="w-3 h-3" />
                      Browsing customers drawn to sales
                      <span className="text-doodle-text/40">
                        (% of new slots)
                      </span>
                    </span>
                    <span className="font-doodle text-xs text-doodle-accent font-semibold">
                      {noOrderPct}%
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[noOrderPct]}
                    onValueChange={([v]) => setNoOrderPct(v)}
                    disabled={status.isRunning || actionPending}
                    className="w-full"
                  />
                </div>

                {/* Abandoned cart % slider (within existing-customer slots) */}
                <div className="space-y-2 ml-4 border-l-2 border-doodle-text/10 pl-4">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-xs text-doodle-text/70 flex items-center gap-1">
                      <ShoppingCart className="w-3 h-3" />
                      Cart recovery orders
                      <span className="text-doodle-text/40">
                        (% of existing slots)
                      </span>
                    </span>
                    <span className="font-doodle text-xs text-doodle-accent font-semibold">
                      {abandonedCartPct}%
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[abandonedCartPct]}
                    onValueChange={([v]) => setAbandonedCartPct(v)}
                    disabled={status.isRunning || actionPending}
                    className="w-full"
                  />
                </div>
              </div>
            )}

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
                  disabled={actionPending || !canStart}
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
                    Order Mix
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
                    <div
                      className="bg-blue-500 transition-all duration-500"
                      style={{ width: `${storePct}%` }}
                      title={`B2B store: ${storePct}%`}
                    />
                  </div>

                  <div className="flex justify-between items-center flex-wrap gap-y-1">
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
                    {status.storeOrderQueued > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-sm bg-blue-500 inline-block border border-doodle-text" />
                        <Store className="w-3.5 h-3.5 text-doodle-text" />
                        <span className="font-doodle text-xs text-doodle-text">
                          B2B{" "}
                          <strong>
                            {status.storeOrderQueued.toLocaleString()}
                          </strong>
                          <span className="text-doodle-text/50 ml-1">
                            ({storePct}%)
                          </span>
                        </span>
                      </div>
                    )}
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
                            {orderTypeBadge(r.orderType)}
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
                          {r.failureCode && (
                            <div className="mt-1">
                              <Badge
                                variant="outline"
                                className="font-doodle text-[10px] py-0 px-1 border-red-300 text-red-700"
                              >
                                {formatFailureCode(r.failureCode)}
                              </Badge>
                            </div>
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
            <strong>Order types:</strong> Consumer orders include new-customer
            personas, repeat top-spenders, browsing customers drawn to sales
            (marketing re-engagement), and abandoned-cart recoveries. B2B store
            orders generate representative replenishment orders based on each
            store's purchase history and current stock levels.
          </p>
          <p className="font-doodle text-sm text-doodle-text/70 leading-relaxed mt-2">
            The simulator <strong>auto-stops</strong> after the configured
            duration (default 24h, max 72h) to prevent runaway Azure costs.
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
