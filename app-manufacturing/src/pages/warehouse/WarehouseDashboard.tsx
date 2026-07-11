import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Warehouse,
  PackagePlus,
  PackageMinus,
  Truck,
  Users,
  AlertTriangle,
  Activity,
  ChevronRight,
  BarChart3,
} from "lucide-react";
import {
  fetchWarehouseStatus,
  fetchWarehouseActive,
  fetchWarehouseDamageEvents,
} from "@/services/warehouseApi";

const opTypeColour: Record<string, string> = {
  Store: "bg-blue-100 text-blue-800",
  Retrieve: "bg-green-100 text-green-800",
  ReceiveSupplier: "bg-purple-100 text-purple-800",
};

const opTypeLabel: Record<string, string> = {
  Store: "Store",
  Retrieve: "Retrieve",
  ReceiveSupplier: "Receive",
};

const WarehouseDashboard: React.FC = () => {
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["warehouse-status"],
    queryFn: fetchWarehouseStatus,
    refetchInterval: 5000,
  });

  const { data: active } = useQuery({
    queryKey: ["warehouse-active"],
    queryFn: fetchWarehouseActive,
    refetchInterval: 5000,
  });

  const { data: damageEvents } = useQuery({
    queryKey: ["warehouse-damage-events"],
    queryFn: () => fetchWarehouseDamageEvents(),
    refetchInterval: 10000,
  });

  const recentDamage = (damageEvents ?? []).slice(0, 5);

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <Warehouse className="h-7 w-7 text-doodle-text" /> Warehouse Overview
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Finished Goods Storage — live throughput, active operations, and
          workforce utilisation.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statusLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="doodle-border-light">
              <CardContent className="p-4">
                <Skeleton className="h-6 w-20 mb-2" />
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <Card className="doodle-border-light">
              <CardContent className="p-4 flex items-start gap-3">
                <Activity className="h-5 w-5 text-doodle-blue mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Queue Depth</p>
                  <p className="text-2xl font-bold">
                    {status?.queueDepth ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {status?.activeOperations ?? 0} active
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="doodle-border-light">
              <CardContent className="p-4 flex items-start gap-3">
                <PackagePlus className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Stored Today</p>
                  <p className="text-2xl font-bold">
                    {status?.storedToday ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    units put away
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="doodle-border-light">
              <CardContent className="p-4 flex items-start gap-3">
                <PackageMinus className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    Retrieved Today
                  </p>
                  <p className="text-2xl font-bold">
                    {status?.retrievedToday ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">units picked</p>
                </div>
              </CardContent>
            </Card>

            <Card className="doodle-border-light">
              <CardContent className="p-4 flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-orange-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Damage Events</p>
                  <p className="text-2xl font-bold">
                    {status?.damageEventsToday ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">today</p>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Worker Utilisation */}
      {status && (
        <Card className="doodle-border-light">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" /> Worker Utilisation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Overall</span>
                <span>{status.workerUtilisationPct.toFixed(0)}%</span>
              </div>
              <Progress
                value={status.workerUtilisationPct}
                className={
                  status.workerUtilisationPct > 90
                    ? "[&>div]:bg-red-500"
                    : status.workerUtilisationPct > 70
                      ? "[&>div]:bg-orange-400"
                      : "[&>div]:bg-green-500"
                }
              />
            </div>
            <div className="grid grid-cols-3 gap-3 pt-1">
              {status.workersByShift.map((s) => (
                <div key={s.shiftId} className="text-center">
                  <p className="text-xs font-medium">{s.shiftName}</p>
                  <p className="text-lg font-bold">{s.working}</p>
                  <p className="text-xs text-muted-foreground">
                    of {s.headcount} working
                  </p>
                </div>
              ))}
            </div>
            <div className="text-right">
              <Link
                to="/warehouse/workforce"
                className="text-xs text-doodle-blue hover:underline inline-flex items-center gap-1"
              >
                View workforce <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Operations (latest 8) */}
      <Card className="doodle-border-light">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Active Operations
          </CardTitle>
          <CardDescription>Operations currently in progress</CardDescription>
        </CardHeader>
        <CardContent>
          {!active || active.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active operations — warehouse is idle.
            </p>
          ) : (
            <div className="space-y-2">
              {active.slice(0, 8).map((op) => {
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
                    className="flex items-center gap-3 py-2 border-b last:border-0"
                  >
                    <Badge
                      className={`text-xs shrink-0 ${opTypeColour[op.operationType] ?? "bg-gray-100 text-gray-800"}`}
                    >
                      {opTypeLabel[op.operationType] ?? op.operationType}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {op.productName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {op.quantity} unit{op.quantity !== 1 ? "s" : ""} ·{" "}
                        {op.assignedWorkerName ?? "unassigned"}
                      </p>
                    </div>
                    <div className="w-24 shrink-0">
                      <Progress value={pct} className="h-1.5" />
                      <p className="text-xs text-muted-foreground text-right mt-0.5">
                        {op.elapsedMinutes.toFixed(1)} min
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {active && active.length > 8 && (
            <div className="pt-2 text-right">
              <Link
                to="/warehouse/floor"
                className="text-xs text-doodle-blue hover:underline inline-flex items-center gap-1"
              >
                View all {active.length} operations{" "}
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Damage Events */}
      <Card className="doodle-border-light">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-orange-500" /> Recent Damage
            Events
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentDamage.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No damage events recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {recentDamage.map((ev) => (
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

      {/* Quick Links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { to: "/warehouse/floor", icon: Warehouse, label: "Floor View" },
          { to: "/warehouse/workforce", icon: Users, label: "Workforce" },
          { to: "/warehouse/config", icon: BarChart3, label: "Configuration" },
          { to: "/receive", icon: Truck, label: "Inventory" },
        ].map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className="doodle-border-light rounded-lg p-3 flex items-center gap-2 hover:bg-doodle-bg/60 transition-colors"
          >
            <Icon className="h-4 w-4 text-doodle-blue" />
            <span className="text-sm font-medium">{label}</span>
            <ChevronRight className="h-3 w-3 ml-auto text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
};

export default WarehouseDashboard;
