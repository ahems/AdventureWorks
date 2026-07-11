import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Warehouse,
  PackageMinus,
  Users,
  AlertTriangle,
  Activity,
  Loader2,
  Clock,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import {
  fetchWarehouseStatus,
  fetchWarehouseActive,
  fetchWarehouseDamageEvents,
  type WarehouseMetrics,
  type WarehouseActiveOperation,
  type WarehouseDamageEvent,
} from "@/services/warehouseService";

const POLL_INTERVAL_MS = 15_000;

const OP_BADGE: Record<string, string> = {
  Store: "bg-blue-100 text-blue-800",
  Retrieve: "bg-green-100 text-green-800",
  ReceiveSupplier: "bg-purple-100 text-purple-800",
};

const OP_LABEL: Record<string, string> = {
  Store: "Store",
  Retrieve: "Retrieve (Pick)",
  ReceiveSupplier: "Receive",
};

interface HistoryPoint {
  time: string;
  queueDepth: number;
  active: number;
}

const WarehousePage: React.FC = () => {
  const [status, setStatus] = React.useState<WarehouseMetrics | null>(null);
  const [active, setActive] = React.useState<WarehouseActiveOperation[]>([]);
  const [damageEvents, setDamageEvents] = React.useState<
    WarehouseDamageEvent[]
  >([]);
  const [history, setHistory] = React.useState<HistoryPoint[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [s, a, d] = await Promise.all([
        fetchWarehouseStatus(),
        fetchWarehouseActive(),
        fetchWarehouseDamageEvents(),
      ]);
      setStatus(s);
      setActive(a);
      setDamageEvents(d);
      setHistory((prev) => {
        const point: HistoryPoint = {
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          queueDepth: s.queueDepth,
          active: s.activeOperations,
        };
        const updated = [...prev, point];
        return updated.slice(-20); // keep last 20 samples
      });
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load warehouse data",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Split active ops by direction for outbound pressure view
  const outboundOps = active.filter((op) => op.operationType === "Retrieve");
  const inboundOps = active.filter(
    (op) =>
      op.operationType === "Store" || op.operationType === "ReceiveSupplier",
  );

  const utilColour = (pct: number) =>
    pct > 90
      ? "[&>div]:bg-red-500"
      : pct > 70
        ? "[&>div]:bg-orange-400"
        : "[&>div]:bg-green-500";

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 container mx-auto px-4 py-6 space-y-6">
        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold font-doodle flex items-center gap-2">
              <Warehouse className="h-6 w-6 text-doodle-accent" /> Warehouse
            </h1>
            <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
              Read-only view of the Finished Goods Storage operation. Refreshes
              every 15 seconds.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {loading && !status ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString()}`
              : "Loading…"}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {loading && !status ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="doodle-card">
                <CardContent className="p-4">
                  <Skeleton className="h-8 w-12 mb-1" />
                  <Skeleton className="h-3 w-24" />
                </CardContent>
              </Card>
            ))
          ) : (
            <>
              <Card className="doodle-card">
                <CardContent className="p-4 flex items-start gap-3">
                  <PackageMinus className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold">{outboundOps.length}</p>
                    <p className="text-xs text-muted-foreground">
                      Active picks
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="doodle-card">
                <CardContent className="p-4 flex items-start gap-3">
                  <Activity className="h-5 w-5 text-doodle-accent mt-0.5 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold">
                      {status?.queueDepth ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">Queue depth</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="doodle-card">
                <CardContent className="p-4 flex items-start gap-3">
                  <Users className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold">
                      {status?.workerUtilisationPct.toFixed(0) ?? 0}%
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Worker utilisation
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="doodle-card">
                <CardContent className="p-4 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-orange-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold">
                      {status?.damageEventsToday ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Damage events today
                    </p>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {/* Queue depth chart */}
        {history.length > 1 && (
          <Card className="doodle-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Queue Depth Over Time</CardTitle>
              <CardDescription>
                Pending + active operations — rising trend may indicate a
                bottleneck
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart
                  data={history}
                  margin={{ top: 4, right: 12, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="queueGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="queueDepth"
                    name="Queue depth"
                    stroke="#6366f1"
                    fill="url(#queueGrad)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="active"
                    name="Active ops"
                    stroke="#22c55e"
                    fill="none"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Worker utilisation by shift */}
        {status && (
          <Card className="doodle-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" /> Worker Utilisation by Shift
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {status.workersByShift.map((s) => {
                const pct =
                  s.headcount > 0 ? (s.working / s.headcount) * 100 : 0;
                return (
                  <div key={s.shiftId}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">{s.shiftName} Shift</span>
                      <span className="text-muted-foreground text-xs">
                        {s.working} working · {s.available} available ·{" "}
                        {s.offShift} off
                      </span>
                    </div>
                    <Progress value={pct} className={utilColour(pct)} />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          {/* Outbound picks (most relevant to admin app users placing orders) */}
          <Card className="doodle-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <PackageMinus className="h-4 w-4 text-green-500" /> Outbound
                Order Picks
              </CardTitle>
              <CardDescription>
                {status?.retrievedToday ?? 0} units picked today ·{" "}
                {outboundOps.length} in progress
              </CardDescription>
            </CardHeader>
            <CardContent>
              {outboundOps.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No picks in progress.
                </p>
              ) : (
                <div className="space-y-2">
                  {outboundOps.slice(0, 8).map((op) => {
                    const totalMins = Math.max(
                      1,
                      (new Date(op.scheduledCompletionUtc).getTime() -
                        new Date(op.scheduledStartUtc).getTime()) /
                        60000,
                    );
                    const pct = Math.min(
                      100,
                      (op.elapsedMinutes / totalMins) * 100,
                    );
                    return (
                      <div
                        key={op.operationId}
                        className="flex items-center gap-3 py-1.5 border-b last:border-0"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {op.productName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {op.quantity} unit{op.quantity !== 1 ? "s" : ""} ·{" "}
                            {op.assignedWorkerName ?? "unassigned"}
                          </p>
                        </div>
                        <div className="w-20 shrink-0">
                          <Progress
                            value={pct}
                            className="h-1.5 [&>div]:bg-green-500"
                          />
                          <p className="text-xs text-muted-foreground text-right mt-0.5">
                            {Math.max(0, totalMins - op.elapsedMinutes).toFixed(
                              1,
                            )}{" "}
                            min
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  {outboundOps.length > 8 && (
                    <p className="text-xs text-muted-foreground pt-1 text-right">
                      +{outboundOps.length - 8} more
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Inbound (store + receive) */}
          <Card className="doodle-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-500" /> Inbound
                Operations
              </CardTitle>
              <CardDescription>
                {status?.storedToday ?? 0} stored · {status?.receivedToday ?? 0}{" "}
                received today
              </CardDescription>
            </CardHeader>
            <CardContent>
              {inboundOps.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No inbound operations in progress.
                </p>
              ) : (
                <div className="space-y-2">
                  {inboundOps.slice(0, 8).map((op) => (
                    <div
                      key={op.operationId}
                      className="flex items-center gap-3 py-1.5 border-b last:border-0"
                    >
                      <Badge
                        className={`text-xs shrink-0 ${OP_BADGE[op.operationType] ?? "bg-gray-100 text-gray-800"}`}
                      >
                        {OP_LABEL[op.operationType] ?? op.operationType}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {op.productName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {op.quantity} unit{op.quantity !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent damage events */}
        <Card className="doodle-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" /> Recent
              Damage Events
            </CardTitle>
            <CardDescription>Latest incidents — read only</CardDescription>
          </CardHeader>
          <CardContent>
            {damageEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No damage events recorded.
              </p>
            ) : (
              <div className="space-y-2">
                {damageEvents.slice(0, 10).map((ev) => (
                  <div
                    key={ev.operationId}
                    className="flex items-start gap-3 py-2 border-b last:border-0"
                  >
                    <Badge
                      variant="outline"
                      className="text-xs shrink-0 border-orange-300 text-orange-700"
                    >
                      {ev.operationType}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {ev.productName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {ev.damagedUnits} damaged · {ev.damageReasonName}
                        {ev.isTotalLoss && (
                          <span className="ml-1 text-red-600 font-medium">
                            · Total loss
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium text-red-600">
                        ${ev.writeOffValue.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(ev.occurredAtUtc).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Today's throughput summary */}
        {status && (
          <Card className="doodle-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Today&apos;s Throughput
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                {[
                  {
                    label: "Stored",
                    value: status.storedToday,
                    colour: "text-blue-600",
                  },
                  {
                    label: "Retrieved",
                    value: status.retrievedToday,
                    colour: "text-green-600",
                  },
                  {
                    label: "Received",
                    value: status.receivedToday,
                    colour: "text-purple-600",
                  },
                  {
                    label: "Total handled",
                    value: status.totalUnitsHandledToday,
                    colour: "text-foreground",
                  },
                ].map(({ label, value, colour }) => (
                  <div
                    key={label}
                    className="p-3 rounded-lg border bg-muted/20"
                  >
                    <p className={`text-2xl font-bold ${colour}`}>{value}</p>
                    <p className="text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default WarehousePage;
