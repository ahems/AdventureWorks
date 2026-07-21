import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Boxes,
  ClipboardList,
  Clock,
  Factory,
  Gauge,
  Package,
  ShoppingCart,
  Skull,
  Truck,
  Users,
  Zap,
  ArrowRight,
  TrendingDown,
  CircleDot,
  Timer,
  Bot,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  fetchManufacturedProducts,
  fetchWorkOrders,
  fetchProductInventory,
  fetchManufacturingStatus,
  fetchActiveOperations,
  type ManufacturingStatus,
  type ActiveOperation,
} from "@/services/api";
import type { WorkOrder } from "@/types/production";
import {
  fetchWorkforce,
  fetchPlanCatalog,
  type WorkforceSnapshot,
  type FinishedGoodSnapshot,
} from "@/services/planningApi";
import { fetchOrders, type PurchaseOrder } from "@/services/supplyChainApi";
import { fetchAgentQueueStatus } from "@/services/agentApi";

import { DashboardSkeleton } from "@/components/LoadingSkeletons";

const getWorkOrderStatus = (wo: WorkOrder) => {
  if (wo.ScrappedQty > 0 && wo.StockedQty === 0) return "Scrapped";
  if (wo.EndDate) return "Completed";
  if (new Date(wo.StartDate) <= new Date()) return "In Progress";
  return "Planned";
};

const statusColors: Record<string, string> = {
  Planned: "bg-doodle-blue/20 text-doodle-blue border-doodle-blue",
  "In Progress": "bg-doodle-green/20 text-doodle-green border-doodle-green",
  Completed: "bg-secondary text-secondary-foreground border-border",
  Scrapped: "bg-doodle-accent/20 text-doodle-accent border-doodle-accent",
};

const Dashboard = () => {
  const navigate = useNavigate();

  // Core data
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
  });
  const { data: products } = useQuery({
    queryKey: ["manufactured-products"],
    queryFn: fetchManufacturedProducts,
  });
  const { data: inventory } = useQuery({
    queryKey: ["product-inventory"],
    queryFn: () => fetchProductInventory(),
  });

  // Live manufacturing status
  const { data: mfgStatus } = useQuery<ManufacturingStatus>({
    queryKey: ["manufacturing-status"],
    queryFn: fetchManufacturingStatus,
    refetchInterval: 5000,
    retry: 1,
  });
  const { data: activeOps } = useQuery<ActiveOperation[]>({
    queryKey: ["manufacturing-active"],
    queryFn: fetchActiveOperations,
    refetchInterval: 5000,
    retry: 1,
  });

  // Workforce
  const { data: workforce } = useQuery<WorkforceSnapshot>({
    queryKey: ["workforce-snapshot"],
    queryFn: fetchWorkforce,
    refetchInterval: 10000,
    retry: 1,
  });

  // (shortage forecast removed — using feasibility-based materialBlocked from fgCatalog instead)

  // Supply chain orders
  const { data: supplyOrders } = useQuery<PurchaseOrder[]>({
    queryKey: ["supply-orders-dashboard"],
    queryFn: fetchOrders,
    refetchInterval: 15000,
    retry: 1,
  });

  // AI Agent queue depth
  const { data: agentQueue } = useQuery({
    queryKey: ["agent-queue-status"],
    queryFn: fetchAgentQueueStatus,
    refetchInterval: 15000,
    retry: 1,
  });

  // Finished goods catalog for stock health
  const { data: fgCatalog } = useQuery<FinishedGoodSnapshot[]>({
    queryKey: ["fg-catalog-dashboard"],
    queryFn: () => fetchPlanCatalog(),
    retry: 1,
  });

  const isLoading = !workOrders && !products;
  if (isLoading)
    return (
      <div className="container mx-auto px-4 py-8">
        <DashboardSkeleton />
      </div>
    );

  // Computed metrics
  const inProgressWOs =
    workOrders?.filter((wo) => getWorkOrderStatus(wo) === "In Progress") || [];
  const plannedWOs =
    workOrders?.filter((wo) => getWorkOrderStatus(wo) === "Planned") || [];

  const stalledCount = mfgStatus?.stalledForMaterials || 0;

  const activeSupplyOrders =
    supplyOrders?.filter((o) => !["complete", "rejected"].includes(o.status)) ||
    [];
  const pendingSupplyValue = activeSupplyOrders.reduce(
    (s, o) => s + o.totalCost,
    0,
  );

  const outOfStock =
    fgCatalog?.filter((fg) => fg.inventorySignal === "out-of-stock") || [];
  const lowStock =
    fgCatalog?.filter((fg) => fg.inventorySignal === "low-stock") || [];
  const lossMaking =
    fgCatalog?.filter((fg) => fg.pricingSignal === "loss-making") || [];

  // Material-blocked: products that can't be built due to missing components
  const materialBlocked =
    fgCatalog?.filter((fg) => fg.maxProducibleNow <= 0) || [];
  const materialLow =
    fgCatalog?.filter(
      (fg) => fg.maxProducibleNow > 0 && fg.maxProducibleNow <= 10,
    ) || [];
  const criticalShortages = materialBlocked.length;
  const warningShortages = materialLow.length;

  const recentScraps = mfgStatus?.recentScrapEvents || [];

  // Active WOs for the table (In Progress + Planned, sorted by due date)
  const activeWorkOrders = [...inProgressWOs, ...plannedWOs]
    .sort(
      (a, b) => new Date(a.DueDate).getTime() - new Date(b.DueDate).getTime(),
    )
    .slice(0, 8);

  // Build alerts
  const alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
    link: string;
    icon: React.ReactNode;
  }[] = [];

  if (stalledCount > 0) {
    alerts.push({
      severity: "critical",
      message: `${stalledCount} work order${stalledCount > 1 ? "s" : ""} stalled — waiting for materials`,
      link: "/execute",
      icon: <AlertTriangle className="w-4 h-4" />,
    });
  }
  if (outOfStock.length > 0) {
    alerts.push({
      severity: "critical",
      message: `${outOfStock.length} finished good${outOfStock.length > 1 ? "s" : ""} out of stock`,
      link: "/plan/intelligence?filter=out-of-stock",
      icon: <Package className="w-4 h-4" />,
    });
  }
  if (criticalShortages > 0) {
    alerts.push({
      severity: "critical",
      message: `${criticalShortages} product${criticalShortages > 1 ? "s" : ""} blocked — missing materials to build`,
      link: "/plan/intelligence",
      icon: <TrendingDown className="w-4 h-4" />,
    });
  }
  if (recentScraps.length > 0) {
    alerts.push({
      severity: "warning",
      message: `${recentScraps.length} recent scrap event${recentScraps.length > 1 ? "s" : ""} on the shop floor`,
      link: "/execute",
      icon: <Skull className="w-4 h-4" />,
    });
  }
  if (warningShortages > 0) {
    alerts.push({
      severity: "warning",
      message: `${warningShortages} product${warningShortages > 1 ? "s" : ""} nearly blocked (≤10 buildable)`,
      link: "/plan/intelligence",
      icon: <Clock className="w-4 h-4" />,
    });
  }
  if (lowStock.length > 0) {
    alerts.push({
      severity: "warning",
      message: `${lowStock.length} finished good${lowStock.length > 1 ? "s" : ""} below safety stock`,
      link: "/receive",
      icon: <Boxes className="w-4 h-4" />,
    });
  }
  if (lossMaking.length > 0) {
    alerts.push({
      severity: "info",
      message: `${lossMaking.length} product${lossMaking.length > 1 ? "s" : ""} selling below cost`,
      link: "/plan/intelligence",
      icon: <TrendingDown className="w-4 h-4" />,
    });
  }

  const alertBg = {
    critical: "bg-destructive/10 border-destructive/30 text-destructive",
    warning: "bg-doodle-accent/10 border-doodle-accent/30 text-doodle-accent",
    info: "bg-doodle-blue/10 border-doodle-blue/30 text-doodle-blue",
  };

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Title row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-foreground">
            Production Hub 🏭
          </h1>
          <p className="font-doodle text-sm text-muted-foreground">
            AdventureWorks Manufacturing Overview
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mfgStatus?.isRunning ? (
            <Badge className="bg-doodle-green/20 text-doodle-green border-doodle-green animate-pulse gap-1">
              <CircleDot className="w-3 h-3" /> Manufacturing Active
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <CircleDot className="w-3 h-3" /> Idle
            </Badge>
          )}
        </div>
      </div>

      {/* Alerts Banner */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.slice(0, 4).map((alert, i) => (
            <Link
              key={i}
              to={alert.link}
              className={`flex items-center gap-3 px-4 py-2.5 border rounded-lg text-sm font-doodle transition-colors hover:opacity-80 ${alertBg[alert.severity]}`}
            >
              {alert.icon}
              <span className="flex-1">{alert.message}</span>
              <ArrowRight className="w-4 h-4 opacity-50" />
            </Link>
          ))}
        </div>
      )}

      {/* KPI Row 1: Operations */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Link
          to="/execute"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5 group"
        >
          <Gauge className="w-5 h-5 text-doodle-green" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {mfgStatus?.queueDepth ?? "—"}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Queue Depth
          </span>
        </Link>

        <Link
          to="/plan"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <ClipboardList className="w-5 h-5 text-doodle-blue" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {inProgressWOs.length}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            In Progress
          </span>
        </Link>

        <Link
          to="/plan"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Timer className="w-5 h-5 text-muted-foreground" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {plannedWOs.length}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Planned
          </span>
        </Link>

        <Link
          to="/execute"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Zap className="w-5 h-5 text-primary" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {mfgStatus?.completedToday ?? 0}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Completed Today
          </span>
        </Link>

        <Link
          to="/execute/workforce"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Users className="w-5 h-5 text-doodle-blue" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {workforce
              ? `${workforce.currentlyWorking}/${workforce.totalActiveWorkers}`
              : "—"}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Workers Active
          </span>
        </Link>

        <Link
          to="/manufacturing-agent"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Bot
            className={`w-5 h-5 ${(agentQueue?.pending ?? 0) > 20 ? "text-destructive" : (agentQueue?.pending ?? 0) > 5 ? "text-doodle-orange" : "text-doodle-blue"}`}
          />
          <span
            className={`font-doodle text-2xl font-bold ${(agentQueue?.pending ?? 0) > 20 ? "text-destructive" : "text-foreground"}`}
          >
            {agentQueue?.pending ?? "—"}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            AI Agent Queue
          </span>
        </Link>
      </div>

      {/* KPI Row 2: Supply & Inventory */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Link
          to="/supply"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Truck className="w-5 h-5 text-doodle-green" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {activeSupplyOrders.length}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Active POs
          </span>
          {pendingSupplyValue > 0 && (
            <span className="font-doodle text-xs text-doodle-green">
              $
              {pendingSupplyValue.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          )}
        </Link>

        <Link
          to="/plan/intelligence"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <TrendingDown
            className={`w-5 h-5 ${criticalShortages > 0 ? "text-destructive" : "text-muted-foreground"}`}
          />
          <span
            className={`font-doodle text-2xl font-bold ${criticalShortages > 0 ? "text-destructive" : "text-foreground"}`}
          >
            {criticalShortages + warningShortages}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Material Shortages
          </span>
        </Link>

        <Link
          to="/plan/intelligence?filter=out-of-stock"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Package
            className={`w-5 h-5 ${outOfStock.length > 0 ? "text-destructive" : "text-doodle-green"}`}
          />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {fgCatalog ? `${outOfStock.length + lowStock.length}` : "—"}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Low/OOS Products
          </span>
          {outOfStock.length > 0 && (
            <span className="font-doodle text-xs text-destructive">
              {outOfStock.length} out of stock
            </span>
          )}
        </Link>

        <Link
          to="/receive/costing"
          className="doodle-card p-4 flex flex-col items-center text-center gap-1.5"
        >
          <Factory className="w-5 h-5 text-primary" />
          <span className="font-doodle text-2xl font-bold text-foreground">
            {products?.length || 0}
          </span>
          <span className="font-doodle text-xs text-muted-foreground">
            Products in Catalog
          </span>
        </Link>
      </div>

      {/* Process Flow */}

      {/* Main Content: Active WOs + Live Operations + Supply Orders */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Active Work Orders */}
        <div className="lg:col-span-2 doodle-card-static p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-doodle text-lg font-bold text-foreground">
              Active Work Orders
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="font-doodle text-xs"
              onClick={() => navigate("/plan")}
            >
              View All <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </div>
          {activeWorkOrders.length === 0 ? (
            <p className="font-doodle text-sm text-muted-foreground py-4 text-center">
              No active work orders
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-doodle text-sm">
                <thead>
                  <tr className="border-b-2 border-border/40">
                    <th className="text-left py-2 px-2">WO</th>
                    <th className="text-left py-2 px-2">Product</th>
                    <th className="text-right py-2 px-2">Qty</th>
                    <th className="text-right py-2 px-2">Stocked</th>
                    <th className="text-center py-2 px-2">Status</th>
                    <th className="text-left py-2 px-2">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {activeWorkOrders.map((wo) => {
                    const status = getWorkOrderStatus(wo);
                    const product = products?.find(
                      (p) => p.ProductID === wo.ProductID,
                    );
                    const isOverdue =
                      new Date(wo.DueDate) < new Date() &&
                      status !== "Completed";
                    return (
                      <tr
                        key={wo.WorkOrderID}
                        className="border-b border-border/20 hover:bg-secondary/30"
                      >
                        <td className="py-2 px-2">
                          <Link
                            to={`/plan/work-orders/${wo.WorkOrderID}`}
                            className="text-doodle-blue hover:underline font-medium"
                          >
                            #{wo.WorkOrderID}
                          </Link>
                        </td>
                        <td className="py-2 px-2 max-w-[200px] truncate">
                          {product?.Name || `#${wo.ProductID}`}
                        </td>
                        <td className="text-right py-2 px-2">{wo.OrderQty}</td>
                        <td className="text-right py-2 px-2">
                          <span
                            className={
                              wo.StockedQty > 0 ? "text-doodle-green" : ""
                            }
                          >
                            {wo.StockedQty}
                          </span>
                        </td>
                        <td className="text-center py-2 px-2">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs border rounded ${statusColors[status]}`}
                          >
                            {status}
                          </span>
                        </td>
                        <td
                          className={`py-2 px-2 ${isOverdue ? "text-destructive font-bold" : ""}`}
                        >
                          {new Date(wo.DueDate).toLocaleDateString()}
                          {isOverdue && <span className="ml-1 text-xs">⚠</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right sidebar: Live Operations + Supply */}
        <div className="space-y-5">
          {/* Live Operations */}
          <div className="doodle-card-static p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-doodle text-sm font-bold text-foreground flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-doodle-green" />
                Live Operations
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="font-doodle text-xs h-7 px-2"
                onClick={() => navigate("/execute/shop-floor")}
              >
                Shop Floor <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
            {!activeOps || activeOps.length === 0 ? (
              <p className="font-doodle text-xs text-muted-foreground text-center py-3">
                No active operations
              </p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {activeOps.slice(0, 6).map((op, i) => (
                  <Link
                    key={i}
                    to={`/execute/work-order/${op.workOrderId}`}
                    className="block p-2 rounded border border-border/30 hover:bg-secondary/30 transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div className="min-w-0">
                        <p className="font-doodle text-xs font-bold text-foreground truncate">
                          {op.productName}
                        </p>
                        <p className="font-doodle text-xs text-muted-foreground">
                          {op.locationName}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 text-doodle-green shrink-0">
                        <CircleDot className="w-2.5 h-2.5 animate-pulse" />
                        <span className="font-doodle text-xs">
                          {op.elapsedMinutes}m
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
                {activeOps.length > 6 && (
                  <p className="font-doodle text-xs text-muted-foreground text-center">
                    +{activeOps.length - 6} more
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Procurement Activity */}
          <div className="doodle-card-static p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-doodle text-sm font-bold text-foreground flex items-center gap-1.5">
                <Truck className="w-4 h-4 text-doodle-blue" />
                Procurement
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="font-doodle text-xs h-7 px-2"
                onClick={() => navigate("/supply")}
              >
                Supply Chain <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
            {activeSupplyOrders.length === 0 ? (
              <p className="font-doodle text-xs text-muted-foreground text-center py-3">
                No active orders
              </p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {activeSupplyOrders.slice(0, 5).map((order) => {
                  const statusColor: Record<string, string> = {
                    pending: "bg-muted text-muted-foreground",
                    approved: "bg-doodle-blue/20 text-doodle-blue",
                  };
                  return (
                    <div
                      key={order.orderId}
                      className="p-2 rounded border border-border/30"
                    >
                      <div className="flex justify-between items-start">
                        <p className="font-doodle text-xs font-bold text-foreground truncate max-w-[140px]">
                          {order.productName}
                        </p>
                        <Badge
                          className={`text-[10px] px-1.5 py-0 h-4 ${statusColor[order.status] || "bg-secondary text-secondary-foreground"}`}
                        >
                          {order.status}
                        </Badge>
                      </div>
                      <p className="font-doodle text-xs text-muted-foreground mt-0.5">
                        {order.qty} units · {order.vendorName}
                        <span className="text-doodle-blue ml-1">
                          PO #{order.orderId}
                        </span>
                      </p>
                    </div>
                  );
                })}
                {activeSupplyOrders.length > 5 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full font-doodle text-xs h-7"
                    onClick={() => navigate("/supply")}
                  >
                    +{activeSupplyOrders.length - 5} more orders
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Station Load Bar (if manufacturing is running) */}
      {mfgStatus?.isRunning &&
        mfgStatus.locationLoad &&
        mfgStatus.locationLoad.length > 0 && (
          <div className="doodle-card-static p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-doodle text-sm font-bold text-foreground flex items-center gap-1.5">
                <Factory className="w-4 h-4 text-primary" />
                Station Utilization
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="font-doodle text-xs h-7 px-2"
                onClick={() => navigate("/execute")}
              >
                Dashboard <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {mfgStatus.locationLoad.slice(0, 8).map((loc) => {
                const activeAtLocation =
                  activeOps?.filter((op) => op.locationId === loc.locationId)
                    .length || 0;
                const utilPct =
                  loc.capacityUnits > 0
                    ? Math.round((activeAtLocation / loc.capacityUnits) * 100)
                    : 0;
                return (
                  <div key={loc.locationId} className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="font-doodle text-xs text-foreground truncate">
                        {loc.locationName}
                      </span>
                      <span className="font-doodle text-xs text-muted-foreground">
                        {activeAtLocation}/{loc.capacityUnits}
                      </span>
                    </div>
                    <Progress value={utilPct} className="h-2" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
    </div>
  );
};

export default Dashboard;
