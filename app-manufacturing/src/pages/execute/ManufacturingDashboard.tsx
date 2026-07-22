import React, { useState, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  AlertTriangle,
  Factory,
  Gauge,
  Layers,
  Package,
  Pause,
  Play,
  RefreshCw,
  Skull,
  Timer,
  Zap,
  X,
  Truck,
  ShieldAlert,
  ChevronRight,
  ShoppingCart,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  fetchManufacturingStatus,
  fetchActiveOperations,
  fetchVendorQuality,
  fetchScrapEvents,
  type ManufacturingStatus,
  type ActiveOperation,
  type VendorQualityData,
  type ScrapEventFull,
} from "@/services/api";
import { fetchOrders, type PurchaseOrder } from "@/services/supplyChainApi";
import { loadOpenDemand } from "@/services/salesApi";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { toast } from "sonner";
import ShortagesPanel from "@/components/ShortagesPanel";

function useAutoRefresh<T>(
  queryKey: string[],
  fn: () => Promise<T>,
  interval: number,
) {
  return useQuery({
    queryKey,
    queryFn: fn,
    refetchInterval: interval,
    refetchIntervalInBackground: true,
  });
}

const ManufacturingDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") || "locations";
  const [activeTab, setActiveTabState] = useState(initialTab);
  const setActiveTab = (tab: string) => {
    setActiveTabState(tab);
    const next = new URLSearchParams(searchParams);
    if (tab === "locations") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };
  const [qualityVendorFilter, setQualityVendorFilter] = useState<number | null>(
    null,
  );
  const {
    data: status,
    isLoading: statusLoading,
    error: statusError,
  } = useAutoRefresh<ManufacturingStatus>(
    ["manufacturing-status"],
    fetchManufacturingStatus,
    120_000,
  );
  const { data: active, isLoading: activeLoading } = useAutoRefresh<
    ActiveOperation[]
  >(["manufacturing-active"], fetchActiveOperations, 120_000);

  // Purchase orders for shortage cross-reference
  const { data: supplyOrders } = useQuery<PurchaseOrder[]>({
    queryKey: ["supply-orders-shortages"],
    queryFn: fetchOrders,
    staleTime: 15_000,
  });

  // Build lookup: productId → active orders with ETA
  const ordersByProduct = useMemo(() => {
    const map = new Map<number, PurchaseOrder[]>();
    if (!supplyOrders) return map;
    for (const o of supplyOrders) {
      if (["complete", "rejected"].includes(o.status)) continue;
      const existing = map.get(o.productId) || [];
      existing.push(o);
      map.set(o.productId, existing);
    }
    return map;
  }, [supplyOrders]);

  // Vendor quality data
  const { data: vendorQuality, isLoading: qualityLoading } = useQuery<
    VendorQualityData[]
  >({
    queryKey: ["vendor-quality"],
    queryFn: fetchVendorQuality,
    staleTime: 30_000,
    enabled: activeTab === "supplier-quality",
  });

  // Scrap events filtered by vendor
  const { data: filteredScrapEvents, isLoading: scrapEventsLoading } = useQuery<
    ScrapEventFull[]
  >({
    queryKey: ["scrap-events", qualityVendorFilter],
    queryFn: () => fetchScrapEvents(qualityVendorFilter ?? undefined),
    staleTime: 30_000,
    enabled: activeTab === "supplier-quality" && qualityVendorFilter !== null,
  });

  if (statusError) {
    return (
      <div className="container mx-auto p-6">
        <Card className="border-destructive">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive mb-2" />
            <p className="text-lg font-semibold">
              Unable to reach manufacturing API
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              The infrastructure may need a moment to warm up. Retrying
              automatically…
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isRunning = status?.isRunning ?? false;

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
            <Factory className="h-7 w-7 text-primary" />
            Manufacturing Dashboard
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Live production status — real-time updates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={isRunning ? "default" : "secondary"}
            className="text-sm px-3 py-1 gap-1"
          >
            {isRunning ? (
              <>
                <Zap className="h-3.5 w-3.5" /> Running
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5" /> Idle
              </>
            )}
          </Badge>
        </div>
      </div>

      {/* KPI Cards */}
      {statusLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6 animate-pulse">
                <div className="h-8 bg-muted rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        status && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <KpiCard
              icon={<Layers className="h-5 w-5" />}
              label="Queue Depth"
              value={status.queueDepth}
              color="text-primary"
              onClick={() => setActiveTab("active")}
            />
            <KpiCard
              icon={<Timer className="h-5 w-5" />}
              label="Pending"
              value={status.pendingWorkOrders}
              color="text-[hsl(var(--doodle-blue))]"
              onClick={() => setActiveTab("active")}
            />
            <KpiCard
              icon={<Activity className="h-5 w-5" />}
              label="In Progress"
              value={status.inProgressWorkOrders}
              color="text-[hsl(var(--doodle-green))]"
              onClick={() => setActiveTab("active")}
            />
            <KpiCard
              icon={<Package className="h-5 w-5" />}
              label="Completed Today"
              value={status.completedToday}
              color="text-accent"
              onClick={() => navigate("/plan?status=Completed")}
            />
            <KpiCard
              icon={<AlertTriangle className="h-5 w-5" />}
              label="Stalled"
              value={status.stalledForMaterials}
              color="text-destructive"
              onClick={() => setActiveTab("shortages")}
            />
          </div>
        )
      )}

      {/* Customer Demand widget */}
      <CustomerDemandCard />

      {/* Tabs for details */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="locations">
            <Gauge className="h-4 w-4 mr-1 hidden sm:inline" /> Locations
          </TabsTrigger>
          <TabsTrigger value="active">
            <Play className="h-4 w-4 mr-1 hidden sm:inline" /> Active Ops
          </TabsTrigger>
          <TabsTrigger value="shortages">
            <AlertTriangle className="h-4 w-4 mr-1 hidden sm:inline" />{" "}
            Shortages
            {status?.shortages?.length ? ` (${status.shortages.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="scrap">
            <Skull className="h-4 w-4 mr-1 hidden sm:inline" /> Scrap
          </TabsTrigger>
          <TabsTrigger value="supplier-quality">
            <ShieldAlert className="h-4 w-4 mr-1 hidden sm:inline" /> Supplier
            Quality
          </TabsTrigger>
        </TabsList>

        {/* Location Load */}
        <TabsContent value="locations">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">
                Location Capacity Load
              </CardTitle>
              <CardDescription>
                Real-time station utilization across the factory floor
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!status?.locationLoad?.length ? (
                <p className="text-muted-foreground text-sm text-center py-4">
                  No location data available — start a production run to
                  populate.
                </p>
              ) : (
                <div className="space-y-4">
                  {status.locationLoad.map((loc) => {
                    const totalSlots = loc.capacityUnits;
                    const activeAtLocation =
                      active?.filter((op) => op.locationId === loc.locationId)
                        .length ?? 0;
                    const pct =
                      totalSlots > 0
                        ? Math.min(
                            100,
                            Math.round((activeAtLocation / totalSlots) * 100),
                          )
                        : 0;
                    return (
                      <div key={loc.locationId} className="space-y-1">
                        <div className="flex justify-between items-center text-sm">
                          <span className="font-medium">
                            {loc.locationName}
                          </span>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>
                              {activeAtLocation}/{totalSlots} slots active
                            </span>
                            <span>{loc.availabilityHrs}h/wk</span>
                          </div>
                        </div>
                        <Progress value={pct} className="h-2" />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Active Operations */}
        <TabsContent value="active">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">Active Operations</CardTitle>
              <CardDescription>
                Currently in-progress routing operations with elapsed time
              </CardDescription>
            </CardHeader>
            <CardContent>
              {activeLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !active?.length ? (
                <p className="text-muted-foreground text-sm text-center py-4">
                  No operations currently in progress.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>WO #</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Op Seq</TableHead>
                      <TableHead>Station</TableHead>
                      <TableHead className="text-right">Elapsed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {active.map((op) => (
                      <TableRow
                        key={`${op.workOrderId}-${op.operationSequence}`}
                      >
                        <TableCell>
                          <button
                            className="text-[hsl(var(--doodle-blue))] hover:underline font-medium cursor-pointer"
                            onClick={() =>
                              navigate(`/plan/work-orders/${op.workOrderId}`)
                            }
                          >
                            #{op.workOrderId}
                          </button>
                        </TableCell>
                        <TableCell className="text-sm">
                          {op.productName}
                        </TableCell>
                        <TableCell>{op.operationSequence}</TableCell>
                        <TableCell>{op.locationName}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {op.elapsedMinutes < 60
                            ? `${op.elapsedMinutes.toFixed(1)}m`
                            : `${(op.elapsedMinutes / 60).toFixed(1)}h`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Shortages */}
        <TabsContent value="shortages">
          <ShortagesPanel status={status} ordersByProduct={ordersByProduct} />
        </TabsContent>

        {/* Scrap Events */}
        <TabsContent value="scrap">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">Recent Scrap Events</CardTitle>
              <CardDescription>
                Last 10 failures across all stations
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!status?.recentScrapEvents?.length ? (
                <p className="text-muted-foreground text-sm text-center py-4">
                  No scrap events recorded yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>WO #</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Station</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {status.recentScrapEvents.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <button
                            className="text-[hsl(var(--doodle-blue))] hover:underline font-medium cursor-pointer"
                            onClick={() =>
                              navigate(`/plan/work-orders/${e.workOrderId}`)
                            }
                          >
                            #{e.workOrderId}
                          </button>
                        </TableCell>
                        <TableCell className="text-sm">
                          {e.productName}
                        </TableCell>
                        <TableCell>{e.locationName}</TableCell>
                        <TableCell className="text-sm">
                          {e.scrapReasonName}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              e.isTotalFailure ? "destructive" : "secondary"
                            }
                          >
                            {e.isTotalFailure ? "Total" : "Partial"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(e.failedAtUtc).toLocaleTimeString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Supplier Quality Board */}
        <TabsContent value="supplier-quality" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="font-doodle flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-destructive" />{" "}
                    Supplier Quality Board
                  </CardTitle>
                  <CardDescription>
                    Vendors with scrap events attributed to incoming material
                    quality
                  </CardDescription>
                </div>
                {qualityVendorFilter !== null && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setQualityVendorFilter(null)}
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Clear Filter
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {qualityLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 rounded" />
                  ))}
                </div>
              ) : !vendorQuality?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ShieldAlert className="mx-auto h-8 w-8 mb-2" />
                  <p className="font-medium">
                    No supplier-attributed scrap events
                  </p>
                  <p className="text-sm">
                    Quality defects will appear here when scrap is attributed to
                    incoming materials from vendors.
                  </p>
                </div>
              ) : (
                <Accordion type="multiple" className="space-y-2">
                  {vendorQuality
                    .sort((a, b) => b.totalScrapEvents - a.totalScrapEvents)
                    .map((v) => {
                      const failRate =
                        v.totalScrapEvents > 0
                          ? Math.round(
                              (v.totalFailures / v.totalScrapEvents) * 100,
                            )
                          : 0;
                      const isFiltered = qualityVendorFilter === v.vendorId;
                      return (
                        <AccordionItem
                          key={v.vendorId}
                          value={String(v.vendorId)}
                          className={`border rounded-lg px-4 ${isFiltered ? "ring-2 ring-destructive/30" : ""}`}
                        >
                          <AccordionTrigger className="hover:no-underline py-3">
                            <div className="flex items-center gap-3 w-full">
                              <div className="flex-1 text-left">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-sm">
                                    {v.vendorName}
                                  </span>
                                  <Badge
                                    variant="destructive"
                                    className="text-xs"
                                  >
                                    {v.totalScrapEvents} events
                                  </Badge>
                                  {v.totalFailures > 0 && (
                                    <Badge
                                      variant="outline"
                                      className="text-xs text-destructive border-destructive/30"
                                    >
                                      {v.totalFailures} total failures
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {v.affectedWorkOrders} work orders affected ·{" "}
                                  {failRate}% failure rate · Last event:{" "}
                                  {new Date(
                                    v.mostRecentEventUtc,
                                  ).toLocaleDateString()}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 mr-4">
                                <Link
                                  to={`/supply/vendors/${v.vendorId}`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Badge
                                    variant="outline"
                                    className="text-xs hover:bg-primary/10 cursor-pointer gap-1"
                                  >
                                    View Vendor{" "}
                                    <ChevronRight className="h-3 w-3" />
                                  </Badge>
                                </Link>
                              </div>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="space-y-3">
                              {/* Component breakdown */}
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Component</TableHead>
                                    <TableHead className="text-right">
                                      Scrap Events
                                    </TableHead>
                                    <TableHead className="text-right">
                                      Total Failures
                                    </TableHead>
                                    <TableHead className="text-right">
                                      Failure Rate
                                    </TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {v.components
                                    .sort(
                                      (a, b) => b.scrapEvents - a.scrapEvents,
                                    )
                                    .map((c) => (
                                      <TableRow key={c.componentProductId}>
                                        <TableCell className="font-medium text-sm">
                                          {c.componentName}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {c.scrapEvents}
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-destructive font-bold">
                                          {c.totalFailures}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          <div className="flex items-center justify-end gap-2">
                                            <Progress
                                              value={
                                                c.scrapEvents > 0
                                                  ? Math.round(
                                                      (c.totalFailures /
                                                        c.scrapEvents) *
                                                        100,
                                                    )
                                                  : 0
                                              }
                                              className="h-2 w-16"
                                            />
                                            <span className="text-xs text-muted-foreground w-8">
                                              {c.scrapEvents > 0
                                                ? Math.round(
                                                    (c.totalFailures /
                                                      c.scrapEvents) *
                                                      100,
                                                  )
                                                : 0}
                                              %
                                            </span>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                </TableBody>
                              </Table>
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-xs"
                                onClick={() =>
                                  setQualityVendorFilter(v.vendorId)
                                }
                              >
                                <Skull className="h-3 w-3 mr-1" /> View Scrap
                                History for {v.vendorName}
                              </Button>
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                </Accordion>
              )}
            </CardContent>
          </Card>

          {/* Filtered scrap events for selected vendor */}
          {qualityVendorFilter !== null && (
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="font-doodle flex items-center gap-2 text-lg">
                  <Skull className="h-5 w-5 text-destructive" />
                  Scrap History —{" "}
                  {vendorQuality?.find(
                    (v) => v.vendorId === qualityVendorFilter,
                  )?.vendorName || `Vendor #${qualityVendorFilter}`}
                </CardTitle>
                <CardDescription>
                  All scrap events attributed to this supplier
                </CardDescription>
              </CardHeader>
              <CardContent>
                {scrapEventsLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-10 rounded" />
                    ))}
                  </div>
                ) : !filteredScrapEvents?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-4">
                    No scrap events found for this vendor.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>WO #</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Station</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Component</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredScrapEvents.map((ev, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <button
                              className="text-[hsl(var(--doodle-blue))] hover:underline font-medium cursor-pointer"
                              onClick={() =>
                                navigate(`/plan/work-orders/${ev.workOrderId}`)
                              }
                            >
                              #{ev.workOrderId}
                            </button>
                          </TableCell>
                          <TableCell className="text-sm">
                            {ev.productName}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {ev.locationName}
                          </TableCell>
                          <TableCell className="text-sm">
                            {ev.scrapReasonName}
                          </TableCell>
                          <TableCell className="text-sm font-medium">
                            {ev.supplierComponentName || "—"}
                          </TableCell>
                          <TableCell className="font-mono">
                            {ev.scrappedQty}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                ev.isTotalFailure ? "destructive" : "secondary"
                              }
                              className="text-xs"
                            >
                              {ev.isTotalFailure ? "Total" : "Partial"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(ev.failedAtUtc).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};

function KpiCard({
  icon,
  label,
  value,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <Card
      className={
        onClick
          ? "cursor-pointer hover:ring-2 hover:ring-primary/30 transition-shadow"
          : ""
      }
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className={color}>{icon}</div>
        <div>
          <p className="text-2xl font-bold font-doodle">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function CustomerDemandCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["open-demand"],
    queryFn: loadOpenDemand,
    refetchInterval: 120_000,
  });
  const { data: products, isLoading: productsLoading } = useQuery({
    queryKey: ["manufactured-products"],
    queryFn: () =>
      import("@/services/api").then((m) => m.fetchManufacturedProducts()),
    staleTime: 5 * 60_000,
  });

  const manufacturedIds = useMemo(() => {
    const s = new Set<number>();
    products?.forEach((p) => s.add(p.ProductID));
    return s;
  }, [products]);

  const productNames = useMemo(() => {
    const m = new Map<number, string>();
    products?.forEach((p) => m.set(p.ProductID, p.Name));
    return m;
  }, [products]);

  // Only show rows for products that are manufactured (MakeFlag = true)
  const filteredRows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) => manufacturedIds.size === 0 || manufacturedIds.has(r.productId),
      ),
    [data?.rows, manufacturedIds],
  );

  const totalUnits = useMemo(
    () => filteredRows.reduce((s, r) => s + r.openQty, 0),
    [filteredRows],
  );

  // Count unique sales orders that contain at least one manufactured product
  const totalOrders = useMemo(() => {
    const ids = new Set<number>();
    filteredRows.forEach((r) =>
      r.orderRefs.forEach((ref) => ids.add(ref.salesOrderId)),
    );
    return ids.size;
  }, [filteredRows]);

  const earliestDue = useMemo(
    () =>
      filteredRows.length > 0
        ? filteredRows.reduce(
            (min, r) =>
              new Date(r.earliestDueDate) < new Date(min)
                ? r.earliestDueDate
                : min,
            filteredRows[0].earliestDueDate,
          )
        : null,
    [filteredRows],
  );

  const top = filteredRows.slice(0, 5);
  const isLoadingAll = isLoading || productsLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-doodle flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-primary" /> Customer Demand
              — Manufactured Products
            </CardTitle>
            <CardDescription>
              Open sales orders for products manufactured in-house
              (purchased/traded items excluded)
            </CardDescription>
          </div>
          <Link
            to="/plan/demand"
            className="text-xs text-[hsl(var(--doodle-blue))] hover:underline inline-flex items-center gap-1"
          >
            View all <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {isLoadingAll ? (
          <Skeleton className="h-16 w-full" />
        ) : totalOrders === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-3">
            No open customer orders for manufactured products right now.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Open Orders</div>
                <div className="text-2xl font-bold font-doodle">
                  {totalOrders}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Open Units</div>
                <div className="text-2xl font-bold font-doodle text-[hsl(var(--doodle-blue))]">
                  {totalUnits}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Earliest Due
                </div>
                <div className="text-sm font-bold font-doodle pt-1">
                  {earliestDue
                    ? new Date(earliestDue).toLocaleDateString()
                    : "—"}
                </div>
              </div>
            </div>
            {top.length > 0 && (
              <div className="border-t pt-2 space-y-1">
                <p className="text-xs text-muted-foreground mb-1">
                  Top manufactured products by open demand
                </p>
                {top.map((r) => (
                  <div
                    key={r.productId}
                    className="flex items-center justify-between text-sm"
                  >
                    <Link
                      to={`/define/products/${r.productId}`}
                      className="text-[hsl(var(--doodle-blue))] hover:underline truncate pr-2"
                    >
                      {productNames.get(r.productId) ??
                        `Product #${r.productId}`}
                    </Link>
                    <span className="font-mono font-bold">{r.openQty}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ManufacturingDashboard;
