import React, { useState, useMemo, useEffect } from "react";
import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Format a UTC ISO timestamp into a compact ETA label.
function formatEta(iso: string | null | undefined): string {
  if (!iso) return "ETA unknown";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "ETA unknown";
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays <= 7) return `in ${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
import {
  BarChart3,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Package,
  ShoppingCart,
  DollarSign,
  Clock,
  ArrowRight,
  Lightbulb,
  ExternalLink,
  Factory,
  ChevronRight,
  Ban,
  Truck,
  Loader2,
  Rocket,
  FileWarning,
} from "lucide-react";

// Backend returns Int32.MaxValue when a Make-flagged product has no active BOM rows
// (min over empty component list). Treat anything implausibly large as "missing BOM".
const MISSING_BOM_THRESHOLD = 1_000_000;
const isMissingBom = (p: { maxProducibleNow: number }) =>
  p.maxProducibleNow >= MISSING_BOM_THRESHOLD;
import CreateProductionOrderDialog from "@/components/CreateProductionOrderDialog";
import AgentControlBanner from "@/components/AgentControlBanner";
import { useManufacturingAgentMode } from "@/hooks/useManufacturingAgentMode";
import {
  fetchPlanCatalog,
  fetchShortageForecast,
  fetchReorderRecommendations,
  fetchOverstock,
  fetchThinMargin,
  fetchFeasibility,
  type FinishedGoodSnapshot,
  type ShortageForecastResponse,
  type ReorderRecommendationsResponse,
  type FeasibilityResult,
  type FeasibilityComponent,
} from "@/services/planningApi";
import {
  placeOrder,
  fetchCatalog as fetchSupplyCatalog,
  fetchOrders,
  type PurchaseOrder,
} from "@/services/supplyChainApi";
import { fetchWorkOrders, beginManufacturingRun } from "@/services/api";
import { toast } from "sonner";

const inventoryBadge = (signal: string) => {
  const map: Record<string, string> = {
    "out-of-stock": "bg-red-100 text-red-800",
    "low-stock": "bg-orange-100 text-orange-800",
    healthy: "bg-green-100 text-green-800",
    overstock: "bg-blue-100 text-blue-800",
  };
  return <Badge className={`${map[signal] || ""} text-xs`}>{signal}</Badge>;
};

const pricingBadge = (signal: string) => {
  const map: Record<string, string> = {
    healthy: "bg-green-100 text-green-800",
    "thin-margin": "bg-yellow-100 text-yellow-800",
    "loss-making": "bg-red-100 text-red-800",
    "no-price": "bg-gray-100 text-gray-800",
  };
  return <Badge className={`${map[signal] || ""} text-xs`}>{signal}</Badge>;
};

const urgencyBadge = (level: string) => {
  const map: Record<string, string> = {
    critical: "bg-red-100 text-red-800",
    warning: "bg-orange-100 text-orange-800",
    watch: "bg-yellow-100 text-yellow-800",
    ok: "bg-green-100 text-green-800",
  };
  return <Badge className={`${map[level] || ""} text-xs`}>{level}</Badge>;
};

const PlanningIntelligence: React.FC = () => {
  const { isAgentActive } = useManufacturingAgentMode();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState("catalog");
  const [catalogFilter, setCatalogFilter] = useState<string>("all");
  const [initiatedProductIds, setInitiatedProductIds] = useState<Set<number>>(
    new Set(),
  );
  const [restockingAll, setRestockingAll] = useState(false);

  // Handle ?filter= query param on mount
  useEffect(() => {
    const filterParam = searchParams.get("filter");
    if (filterParam) {
      setCatalogFilter(filterParam);
      setTab("catalog");
      // Clear the param so it doesn't persist on tab changes
      setSearchParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["plan-catalog"],
    queryFn: () => fetchPlanCatalog(),
  });

  // Fetch active work orders to know what's currently in production
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders-active"],
    queryFn: () => fetchWorkOrders(),
  });

  // Map productId → total qty currently being manufactured (no EndDate = in progress)
  const inProductionByProduct = useMemo(() => {
    const map = new Map<number, number>();
    if (!workOrders) return map;
    workOrders.forEach((wo) => {
      if (!wo.EndDate) {
        map.set(wo.ProductID, (map.get(wo.ProductID) || 0) + wo.OrderQty);
      }
    });
    return map;
  }, [workOrders]);

  const catalogGroups = useMemo(() => {
    if (!catalog) return [];
    const groups: {
      key: string;
      label: string;
      icon: React.ReactNode;
      color: string;
      items: FinishedGoodSnapshot[];
      priority: number;
    }[] = [
      {
        key: "out-of-stock",
        label: "Out of Stock — Needs Production",
        icon: <AlertTriangle className="h-4 w-4 text-destructive" />,
        color: "text-destructive",
        items: [],
        priority: 0,
      },
      {
        key: "low-stock",
        label: "Low Stock — Monitor Closely",
        icon: <TrendingDown className="h-4 w-4 text-orange-500" />,
        color: "text-orange-500",
        items: [],
        priority: 1,
      },
      {
        key: "healthy",
        label: "Healthy Stock",
        icon: <Package className="h-4 w-4 text-green-600" />,
        color: "text-green-600",
        items: [],
        priority: 2,
      },
      {
        key: "overstock",
        label: "Overstocked",
        icon: <TrendingUp className="h-4 w-4 text-blue-500" />,
        color: "text-blue-500",
        items: [],
        priority: 3,
      },
    ];
    const map = Object.fromEntries(groups.map((g) => [g.key, g]));
    catalog.forEach((p) => {
      map[p.inventorySignal]?.items.push(p);
    });
    groups.forEach((g) => {
      if (g.key === "out-of-stock" || g.key === "low-stock") {
        // Missing-BOM items first (they need engineering attention before any production),
        // then by largest producible count.
        g.items.sort((a, b) => {
          const aMissing = isMissingBom(a) ? 1 : 0;
          const bMissing = isMissingBom(b) ? 1 : 0;
          if (aMissing !== bMissing) return bMissing - aMissing;
          return b.maxProducibleNow - a.maxProducibleNow;
        });
      } else {
        g.items.sort(
          (a, b) =>
            (a.weeksOfSupply === -1 ? Infinity : a.weeksOfSupply) -
            (b.weeksOfSupply === -1 ? Infinity : b.weeksOfSupply),
        );
      }
    });
    return groups.filter((g) => g.items.length > 0);
  }, [catalog]);

  const filteredGroups = useMemo(() => {
    if (catalogFilter === "all") return catalogGroups;
    if (catalogFilter === "low-out")
      return catalogGroups.filter(
        (g) => g.key === "out-of-stock" || g.key === "low-stock",
      );
    return catalogGroups.filter((g) => g.key === catalogFilter);
  }, [catalogGroups, catalogFilter]);

  const { data: forecast, isLoading: forecastLoading } = useQuery({
    queryKey: ["shortage-forecast"],
    queryFn: () => fetchShortageForecast(90),
  });

  const { data: reorder, isLoading: reorderLoading } = useQuery({
    queryKey: ["reorder-recs"],
    queryFn: () => fetchReorderRecommendations(60),
  });

  const { data: overstock } = useQuery({
    queryKey: ["overstock"],
    queryFn: () => fetchOverstock(12),
  });

  const { data: thinMargin } = useQuery({
    queryKey: ["thin-margin"],
    queryFn: () => fetchThinMargin(0.2),
  });

  // Material-blocked products: low/out-of-stock with very limited buildability
  const materialBlockedProducts = useMemo(() => {
    if (!catalog) return [];
    return catalog
      .filter(
        (p) =>
          (p.inventorySignal === "out-of-stock" ||
            p.inventorySignal === "low-stock") &&
          p.maxProducibleNow >= 0 &&
          p.maxProducibleNow <= 10,
      )
      .sort((a, b) => a.maxProducibleNow - b.maxProducibleNow)
      .slice(0, 25);
  }, [catalog]);

  // Fetch feasibility for each material-blocked product at a target qty (safety stock level or 10)
  const feasibilityQueries = useQueries({
    queries: materialBlockedProducts.map((p) => ({
      queryKey: ["feasibility-blocked", p.productId],
      queryFn: () =>
        fetchFeasibility(p.productId, Math.max(10, p.maxProducibleNow + 5)),
      staleTime: 120_000,
      enabled: tab === "reorder",
    })),
  });

  // Fetch supply catalog for vendor lookup
  const { data: supplyCatalog } = useQuery({
    queryKey: ["supply-catalog"],
    queryFn: () => fetchSupplyCatalog(),
    staleTime: 120_000,
    enabled: tab === "reorder",
  });

  // Fetch active purchase orders to show "on order" quantities
  const { data: activeOrders } = useQuery<PurchaseOrder[]>({
    queryKey: ["supply-orders-blocked"],
    queryFn: fetchOrders,
    staleTime: 30_000,
    enabled: tab === "reorder",
  });

  // Build on-order lookup: productId → list of open POs (sorted by earliest ETA)
  const ordersByProduct = useMemo(() => {
    const map = new Map<number, PurchaseOrder[]>();
    if (!activeOrders) return map;
    for (const o of activeOrders) {
      if (["complete", "rejected"].includes(o.status)) continue;
      const list = map.get(o.productId) || [];
      list.push(o);
      map.set(o.productId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ta = new Date(a.estimatedDeliveryUtc).getTime() || Infinity;
        const tb = new Date(b.estimatedDeliveryUtc).getTime() || Infinity;
        return ta - tb;
      });
    }
    return map;
  }, [activeOrders]);

  const onOrderQty = (productId: number) =>
    (ordersByProduct.get(productId) || []).reduce((s, o) => s + o.qty, 0);

  // Build vendor lookup: productId → vendors
  const vendorByProduct = useMemo(() => {
    const map = new Map<
      number,
      {
        vendorId: string;
        vendorName: string;
        unitCost: number;
        stockAvailable: number;
        leadTimeDays: number;
        minOrderQty: number;
        maxOrderQty: number;
      }[]
    >();
    if (!supplyCatalog) return map;
    for (const quote of supplyCatalog) {
      const existing = map.get(quote.productId) || [];
      existing.push({
        vendorId: quote.vendorId,
        vendorName: quote.vendorName,
        unitCost: quote.unitCost,
        stockAvailable: quote.stockAvailable,
        leadTimeDays: quote.leadTimeDays,
        minOrderQty: quote.minOrderQty || 1,
        maxOrderQty: quote.maxOrderQty || quote.stockAvailable,
      });
      map.set(quote.productId, existing);
    }
    return map;
  }, [supplyCatalog]);

  // Aggregate material-blocked data
  const materialBlockedData = useMemo(() => {
    return materialBlockedProducts
      .map((p, idx) => {
        const fq = feasibilityQueries[idx];
        const feasibility = fq?.data as FeasibilityResult | undefined;
        const shortfalls =
          feasibility?.components.filter((c) => c.shortfallForQty > 0) || [];
        return {
          product: p,
          feasibility,
          shortfalls,
          isLoading: fq?.isLoading ?? true,
        };
      })
      .filter((d) => d.shortfalls.length > 0 || d.isLoading);
  }, [materialBlockedProducts, feasibilityQueries]);

  const orderMutation = useMutation({
    mutationFn: async (rec: {
      vendorId: string;
      productId: number;
      qty: number;
      minOrderQty: number;
      maxOrderQty: number;
      stockAvailable: number;
    }) => {
      const actualQty = Math.min(
        Math.max(rec.qty, rec.minOrderQty),
        rec.maxOrderQty,
        rec.stockAvailable,
      );
      if (actualQty > rec.stockAvailable || rec.stockAvailable <= 0) {
        throw new Error(
          `Vendor has insufficient stock (${rec.stockAvailable} available, min order: ${rec.minOrderQty})`,
        );
      }
      return placeOrder(rec.vendorId, rec.productId, actualQty);
    },
    onSuccess: (order) => {
      toast.success(
        `Ordered ${order.productName} x${order.qty} from ${order.vendorName}`,
      );
      qc.invalidateQueries({ queryKey: ["reorder-recs"] });
      qc.invalidateQueries({ queryKey: ["supply-orders"] });
      qc.invalidateQueries({ queryKey: ["feasibility-blocked"] });
      qc.invalidateQueries({ queryKey: ["supply-catalog-blocked"] });
      qc.invalidateQueries({ queryKey: ["supply-catalog"] });
      qc.invalidateQueries({ queryKey: ["supply-orders-blocked"] });
    },
    onError: (e: Error) =>
      toast.error("Order failed", { description: e.message }),
  });

  // Summary counts
  const outOfStock =
    catalog?.filter((c) => c.inventorySignal === "out-of-stock").length ?? 0;
  const lowStock =
    catalog?.filter((c) => c.inventorySignal === "low-stock").length ?? 0;
  const lossMaking =
    catalog?.filter((c) => c.pricingSignal === "loss-making").length ?? 0;
  const materialBlockedCount = materialBlockedData.filter(
    (d) => d.shortfalls.length > 0,
  ).length;

  // Restock All: produce all out-of-stock items up to maxProducibleNow
  const restockableItems = useMemo(() => {
    if (!catalog) return [];
    return catalog.filter(
      (p) =>
        p.inventorySignal === "out-of-stock" &&
        p.maxProducibleNow > 0 &&
        !isMissingBom(p) &&
        !inProductionByProduct.has(p.productId) &&
        !initiatedProductIds.has(p.productId),
    );
  }, [catalog, inProductionByProduct, initiatedProductIds]);

  const handleRestockAll = async () => {
    if (restockableItems.length === 0) return;
    setRestockingAll(true);
    let successCount = 0;
    let failCount = 0;
    for (const item of restockableItems) {
      try {
        await beginManufacturingRun({
          productId: item.productId,
          orderQty: item.maxProducibleNow,
        });
        setInitiatedProductIds((prev) => new Set(prev).add(item.productId));
        successCount++;
      } catch (e: unknown) {
        console.error(`Failed to restock ${item.name}:`, e);
        failCount++;
      }
    }
    setRestockingAll(false);
    if (successCount > 0) {
      toast.success(
        `Initiated production for ${successCount} product${successCount > 1 ? "s" : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["work-orders-active"] });
      qc.invalidateQueries({ queryKey: ["plan-catalog"] });
    }
    if (failCount > 0) {
      toast.error(
        `${failCount} product${failCount > 1 ? "s" : ""} failed to start production`,
      );
    }
  };

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <AgentControlBanner />
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <BarChart3 className="h-7 w-7 text-primary" /> Planning Intelligence
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Production feasibility, margin analysis, shortage forecasting, and
          reorder recommendations
        </p>
      </div>

      {/* Alert Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className={forecast?.critical ? "border-destructive" : ""}>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle
              className={`h-5 w-5 ${forecast?.critical ? "text-destructive" : "text-muted-foreground"}`}
            />
            <div>
              <p className="text-2xl font-bold font-doodle">
                {forecast?.critical ?? "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                Critical Shortages
              </p>
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => {
            setCatalogFilter("low-out");
            setTab("catalog");
          }}
        >
          <CardContent className="p-4 flex items-center gap-3">
            <Package className="h-5 w-5 text-orange-500" />
            <div>
              <p className="text-2xl font-bold font-doodle">
                {outOfStock + lowStock}
              </p>
              <p className="text-xs text-muted-foreground">Low/Out of Stock</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingDown className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-2xl font-bold font-doodle">{lossMaking}</p>
              <p className="text-xs text-muted-foreground">Loss-Making</p>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 transition-shadow">
          <Link to="/plan/finance">
            <CardContent className="p-4 flex items-center gap-3">
              <DollarSign className="h-5 w-5 text-primary" />
              <div>
                <p className="text-2xl font-bold font-doodle">
                  {reorder
                    ? `$${reorder.estimatedTotalProcurementCost.toFixed(0)}`
                    : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Reorder Cost Est.
                </p>
              </div>
            </CardContent>
          </Link>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="catalog">
            <Package className="h-4 w-4 mr-1 hidden sm:inline" /> Catalog
          </TabsTrigger>
          <TabsTrigger value="shortages">
            <AlertTriangle className="h-4 w-4 mr-1 hidden sm:inline" />{" "}
            Shortages
          </TabsTrigger>
          <TabsTrigger value="reorder">
            <ShoppingCart className="h-4 w-4 mr-1 hidden sm:inline" /> Reorder{" "}
            {materialBlockedCount > 0 && (
              <Badge
                variant="destructive"
                className="ml-1 text-[10px] px-1.5 py-0"
              >
                {materialBlockedCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="overstock">
            <TrendingUp className="h-4 w-4 mr-1 hidden sm:inline" /> Overstock
          </TabsTrigger>
          <TabsTrigger value="margins">
            <DollarSign className="h-4 w-4 mr-1 hidden sm:inline" /> Margins
          </TabsTrigger>
        </TabsList>

        {/* Product Catalog with Feasibility */}
        <TabsContent value="catalog">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <CardTitle className="font-doodle">
                    Finished Goods Catalog
                  </CardTitle>
                  <CardDescription>
                    {catalog?.length ?? 0} products grouped by inventory status
                    — prioritized for manufacturing decisions
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant={catalogFilter === "all" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCatalogFilter("all")}
                  >
                    All ({catalog?.length ?? 0})
                  </Button>
                  {catalogGroups.map((g) => (
                    <Button
                      key={g.key}
                      variant={catalogFilter === g.key ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCatalogFilter(g.key)}
                    >
                      {g.icon}
                      <span className="ml-1">{g.items.length}</span>
                    </Button>
                  ))}
                </div>
                {(catalogFilter === "out-of-stock" ||
                  catalogFilter === "all") &&
                  restockableItems.length > 0 && (
                    <Button
                      size="sm"
                      onClick={handleRestockAll}
                      disabled={restockingAll}
                      className="gap-1.5"
                    >
                      {restockingAll ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
                          Restocking…
                        </>
                      ) : (
                        <>
                          <Rocket className="h-3.5 w-3.5" /> Restock All (
                          {restockableItems.length})
                        </>
                      )}
                    </Button>
                  )}
              </div>
            </CardHeader>
            <CardContent>
              {catalogLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-16 rounded" />
                  ))}
                </div>
              ) : !filteredGroups.length ? (
                <p className="text-center text-muted-foreground py-8">
                  No products match this filter.
                </p>
              ) : (
                <Accordion
                  type="multiple"
                  defaultValue={["out-of-stock", "low-stock"]}
                  className="space-y-2"
                >
                  {filteredGroups.map((group) => (
                    <AccordionItem
                      key={group.key}
                      value={group.key}
                      className="border rounded-lg px-4"
                    >
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center gap-3">
                          {group.icon}
                          <span className="font-bold font-doodle">
                            {group.label}
                          </span>
                          <Badge variant="secondary" className="ml-1">
                            {group.items.length}
                          </Badge>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Product</TableHead>
                              <TableHead className="text-right">
                                Price
                              </TableHead>
                              <TableHead className="text-right">
                                Margin
                              </TableHead>
                              <TableHead className="text-right">
                                Stock
                              </TableHead>
                              <TableHead className="text-right">
                                In Prod.
                              </TableHead>
                              <TableHead className="text-right">
                                Wks Supply
                              </TableHead>
                              <TableHead className="text-right">
                                Can Build
                              </TableHead>
                              <TableHead className="text-right">
                                Actions
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.items.map((p) => {
                              const inProd =
                                inProductionByProduct.get(p.productId) || 0;
                              const effectiveStock = p.currentStockQty + inProd;
                              const alreadyCovered =
                                inProd > 0 &&
                                effectiveStock >= p.currentStockQty; // has production in flight
                              return (
                                <TableRow key={p.productId}>
                                  <TableCell>
                                    <Link
                                      to={`/plan/work-orders?product=${p.productId}`}
                                      className="text-sm font-medium hover:text-primary"
                                    >
                                      {p.name}
                                    </Link>
                                    {p.productNumber && (
                                      <span className="text-xs text-muted-foreground ml-1">
                                        {p.productNumber}
                                      </span>
                                    )}
                                    <div className="flex gap-1 mt-0.5">
                                      {pricingBadge(p.pricingSignal)}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    ${p.listPrice.toFixed(2)}
                                  </TableCell>
                                  <TableCell
                                    className={`text-right font-mono ${p.grossMarginPct < 0 ? "text-destructive" : ""}`}
                                  >
                                    {(p.grossMarginPct * 100).toFixed(1)}%
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    {p.currentStockQty}
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    {inProd > 0 ? (
                                      <span className="text-primary font-bold">
                                        +{inProd}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground">
                                        —
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    {p.weeksOfSupply === -1
                                      ? "∞"
                                      : p.weeksOfSupply.toFixed(1)}
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-bold">
                                    {isMissingBom(p) ? (
                                      <Badge
                                        variant="destructive"
                                        className="text-[10px] gap-1"
                                      >
                                        <FileWarning className="h-3 w-3" /> No
                                        BOM
                                      </Badge>
                                    ) : p.maxProducibleNow === -1 ? (
                                      "∞"
                                    ) : (
                                      p.maxProducibleNow
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex items-center justify-end gap-1">
                                      {isMissingBom(p) ? (
                                        <Link
                                          to={`/engineer/bom/${p.productId}`}
                                        >
                                          <Button
                                            variant="default"
                                            size="sm"
                                            className="text-xs"
                                          >
                                            <FileWarning className="h-3 w-3 mr-1" />{" "}
                                            Define BOM
                                          </Button>
                                        </Link>
                                      ) : (
                                        (group.key === "out-of-stock" ||
                                          group.key === "low-stock") &&
                                        (inProd > 0 ||
                                        initiatedProductIds.has(p.productId) ? (
                                          <Badge
                                            variant="secondary"
                                            className="text-xs"
                                          >
                                            <Factory className="h-3 w-3 mr-1" />{" "}
                                            In Production
                                          </Badge>
                                        ) : (
                                          <CreateProductionOrderDialog
                                            disabled={isAgentActive}
                                            prefillProductId={p.productId}
                                            prefillQty={Math.max(
                                              1,
                                              p.maxProducibleNow > 0
                                                ? p.maxProducibleNow
                                                : 10,
                                            )}
                                            onSuccess={() =>
                                              setInitiatedProductIds((prev) =>
                                                new Set(prev).add(p.productId),
                                              )
                                            }
                                            trigger={
                                              p.maxProducibleNow === 0 ? (
                                                <Button
                                                  variant="secondary"
                                                  size="sm"
                                                  className="text-xs"
                                                >
                                                  <Clock className="h-3 w-3 mr-1" />{" "}
                                                  Schedule
                                                </Button>
                                              ) : (
                                                <Button
                                                  variant="default"
                                                  size="sm"
                                                  className="text-xs"
                                                >
                                                  <Factory className="h-3 w-3 mr-1" />{" "}
                                                  Produce
                                                </Button>
                                              )
                                            }
                                          />
                                        ))
                                      )}
                                      <a
                                        href={`https://polite-field-01102b10f.6.azurestaticapps.net/product/${p.productId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-xs"
                                        >
                                          <ExternalLink className="h-3 w-3" />
                                        </Button>
                                      </a>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Shortage Forecast */}
        <TabsContent value="shortages">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">
                Component Shortage Forecast
              </CardTitle>
              <CardDescription>
                Purchased components forecast to run out within 90 days based on
                sales velocity
              </CardDescription>
            </CardHeader>
            <CardContent>
              {forecastLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 rounded" />
                  ))}
                </div>
              ) : !forecast?.items.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Lightbulb className="mx-auto h-8 w-8 mb-2" />
                  <p className="font-medium">No shortages forecast</p>
                  <p className="text-sm">
                    All components have adequate stock for the next 90 days at
                    current sales rates.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Component</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Daily Use</TableHead>
                      <TableHead className="text-right">Days Left</TableHead>
                      <TableHead>Urgency</TableHead>
                      <TableHead>Affects</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecast.items.map((item) => (
                      <TableRow key={item.componentProductId}>
                        <TableCell className="font-medium">
                          {item.componentName}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {item.currentStock}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {item.dailyConsumptionRate.toFixed(1)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {item.daysUntilStockout.toFixed(0)}
                        </TableCell>
                        <TableCell>{urgencyBadge(item.urgencyLevel)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.affectedProducts
                            .slice(0, 3)
                            .map((a) => a.name)
                            .join(", ")}
                          {item.affectedProducts.length > 3 &&
                            ` +${item.affectedProducts.length - 3}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reorder" className="space-y-6">
          {/* Material-Blocked Products */}
          <Card
            className={materialBlockedCount > 0 ? "border-destructive/50" : ""}
          >
            <CardHeader>
              <div className="flex items-center gap-2">
                <Ban className="h-5 w-5 text-destructive" />
                <div>
                  <CardTitle className="font-doodle">
                    Material-Blocked Products
                  </CardTitle>
                  <CardDescription>
                    {materialBlockedCount > 0
                      ? `${materialBlockedCount} finished goods cannot reach target build quantity due to missing purchased components`
                      : "Checking which products are blocked by missing components…"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {materialBlockedData.some((d) => d.isLoading) ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-20 rounded" />
                  ))}
                </div>
              ) : materialBlockedData.filter((d) => d.shortfalls.length > 0)
                  .length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Package className="mx-auto h-8 w-8 mb-2" />
                  <p className="font-medium">No material-blocked products</p>
                  <p className="text-sm">
                    All low-stock products have sufficient components for at
                    least a small production run.
                  </p>
                </div>
              ) : (
                <Accordion type="multiple" className="space-y-2">
                  {materialBlockedData
                    .filter((d) => d.shortfalls.length > 0)
                    .map(({ product: p, feasibility, shortfalls }) => {
                      const coveredCount = shortfalls.filter((c) => {
                        return onOrderQty(c.productId) >= c.shortfallForQty;
                      }).length;
                      const allCovered = coveredCount === shortfalls.length;
                      return (
                        <AccordionItem
                          key={p.productId}
                          value={String(p.productId)}
                          className={`border rounded-lg px-4 ${allCovered ? "border-primary/30 bg-primary/5" : ""}`}
                        >
                          <AccordionTrigger className="hover:no-underline py-3">
                            <div className="flex items-center gap-3 w-full">
                              <div className="flex-1 text-left">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-sm">
                                    {p.name}
                                  </span>
                                  {inventoryBadge(p.inventorySignal)}
                                  {allCovered ? (
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-primary/10 text-primary border-primary/30"
                                    >
                                      <Truck className="h-3 w-3 mr-0.5" /> All
                                      on order ✓
                                    </Badge>
                                  ) : coveredCount > 0 ? (
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-primary/10 text-primary border-primary/30"
                                    >
                                      {coveredCount}/{shortfalls.length} on
                                      order
                                    </Badge>
                                  ) : null}
                                  {!allCovered && (
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-destructive/10 text-destructive border-destructive/30"
                                    >
                                      {shortfalls.length - coveredCount} missing
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Stock: {p.currentStockQty} · Can build:{" "}
                                  {feasibility?.maxProducibleNow ??
                                    p.maxProducibleNow}
                                  {feasibility && (
                                    <> · Target: {feasibility.requestedQty}</>
                                  )}
                                </p>
                              </div>
                              {feasibility &&
                                feasibility.procurementCostToMeetRequest >
                                  0 && (
                                  <span className="text-sm font-mono font-bold text-primary mr-2">
                                    $
                                    {feasibility.procurementCostToMeetRequest.toFixed(
                                      2,
                                    )}
                                  </span>
                                )}
                            </div>
                          </AccordionTrigger>
                          <AccordionContent>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Missing Component</TableHead>
                                  <TableHead className="text-right">
                                    In Stock
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Need
                                  </TableHead>
                                  <TableHead className="text-right">
                                    On Order
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Eff. Shortfall
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Vendor
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Action
                                  </TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {shortfalls.map((comp) => {
                                  const vendors =
                                    vendorByProduct.get(comp.productId) || [];
                                  const bestVendor = vendors.sort(
                                    (a, b) => a.unitCost - b.unitCost,
                                  )[0];
                                  const orders =
                                    ordersByProduct.get(comp.productId) || [];
                                  const onOrder = orders.reduce(
                                    (s, o) => s + o.qty,
                                    0,
                                  );
                                  const effectiveShortfall = Math.max(
                                    0,
                                    comp.shortfallForQty - onOrder,
                                  );
                                  const earliestEta =
                                    orders[0]?.estimatedDeliveryUtc;
                                  return (
                                    <TableRow
                                      key={comp.productId}
                                      className={
                                        effectiveShortfall === 0
                                          ? "bg-primary/5"
                                          : ""
                                      }
                                    >
                                      <TableCell className="font-medium text-sm">
                                        {comp.name}
                                      </TableCell>
                                      <TableCell className="text-right font-mono">
                                        {comp.currentStock}
                                      </TableCell>
                                      <TableCell className="text-right font-mono">
                                        {comp.requiredForQty}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {orders.length === 0 ? (
                                          <span className="text-muted-foreground font-mono">
                                            —
                                          </span>
                                        ) : orders.length === 1 ? (
                                          <Link
                                            to={`/supply/orders/${orders[0].orderId}`}
                                            className="inline-flex items-center gap-1 font-mono text-primary font-bold hover:underline"
                                            title={`PO #${orders[0].orderId.slice(-6)} from ${orders[0].vendorName}`}
                                          >
                                            <Truck className="h-3 w-3" />{" "}
                                            {onOrder}
                                            <span className="text-xs font-normal text-muted-foreground ml-1">
                                              · ETA {formatEta(earliestEta)}
                                            </span>
                                            {effectiveShortfall === 0 && (
                                              <span className="text-xs">
                                                {" "}
                                                ✓
                                              </span>
                                            )}
                                          </Link>
                                        ) : (
                                          <Popover>
                                            <PopoverTrigger asChild>
                                              <button className="inline-flex items-center gap-1 font-mono text-primary font-bold hover:underline">
                                                <Truck className="h-3 w-3" />{" "}
                                                {onOrder}
                                                <span className="text-xs font-normal text-muted-foreground ml-1">
                                                  · {orders.length} POs · next{" "}
                                                  {formatEta(earliestEta)}
                                                </span>
                                                {effectiveShortfall === 0 && (
                                                  <span className="text-xs">
                                                    {" "}
                                                    ✓
                                                  </span>
                                                )}
                                              </button>
                                            </PopoverTrigger>
                                            <PopoverContent
                                              className="w-72 p-2"
                                              align="end"
                                            >
                                              <p className="text-xs font-bold text-muted-foreground px-2 pb-1">
                                                Open purchase orders
                                              </p>
                                              <div className="space-y-0.5">
                                                {orders.map((o) => (
                                                  <Link
                                                    key={o.orderId}
                                                    to={`/supply/orders/${o.orderId}`}
                                                    className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded hover:bg-muted"
                                                  >
                                                    <span className="font-mono text-primary">
                                                      #{o.orderId.slice(-6)}
                                                    </span>
                                                    <span className="text-muted-foreground truncate flex-1">
                                                      {o.vendorName}
                                                    </span>
                                                    <span className="font-mono">
                                                      qty {o.qty}
                                                    </span>
                                                    <span className="text-muted-foreground whitespace-nowrap">
                                                      {formatEta(
                                                        o.estimatedDeliveryUtc,
                                                      )}
                                                    </span>
                                                  </Link>
                                                ))}
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                        )}
                                      </TableCell>
                                      <TableCell
                                        className={`text-right font-mono font-bold ${effectiveShortfall === 0 ? "text-primary" : "text-destructive"}`}
                                      >
                                        {effectiveShortfall === 0
                                          ? "Covered"
                                          : effectiveShortfall}
                                      </TableCell>
                                      <TableCell className="text-right text-xs">
                                        {bestVendor ? (
                                          <span>
                                            {bestVendor.vendorName}
                                            <br />$
                                            {bestVendor.unitCost.toFixed(2)}/ea
                                            · {bestVendor.leadTimeDays}d
                                            {bestVendor.minOrderQty > 1 && (
                                              <>
                                                <br />
                                                min: {bestVendor.minOrderQty}
                                              </>
                                            )}
                                          </span>
                                        ) : (
                                          <span className="text-muted-foreground">
                                            No vendor
                                          </span>
                                        )}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {effectiveShortfall === 0 ? (
                                          <Badge
                                            variant="outline"
                                            className="text-xs bg-primary/10 text-primary border-primary/30"
                                          >
                                            <Truck className="h-3 w-3 mr-1" />{" "}
                                            On Order
                                          </Badge>
                                        ) : bestVendor ? (
                                          (() => {
                                            const orderQty = Math.min(
                                              Math.max(
                                                effectiveShortfall,
                                                bestVendor.minOrderQty,
                                              ),
                                              bestVendor.maxOrderQty,
                                              bestVendor.stockAvailable,
                                            );
                                            const canOrder =
                                              bestVendor.stockAvailable >=
                                              bestVendor.minOrderQty;
                                            return (
                                              <Button
                                                size="sm"
                                                variant="default"
                                                className="text-xs"
                                                disabled={
                                                  orderMutation.isPending ||
                                                  !canOrder
                                                }
                                                onClick={() =>
                                                  orderMutation.mutate({
                                                    vendorId:
                                                      bestVendor.vendorId,
                                                    productId: comp.productId,
                                                    qty: orderQty,
                                                    minOrderQty:
                                                      bestVendor.minOrderQty,
                                                    maxOrderQty:
                                                      bestVendor.maxOrderQty,
                                                    stockAvailable:
                                                      bestVendor.stockAvailable,
                                                  })
                                                }
                                              >
                                                <ShoppingCart className="h-3 w-3 mr-1" />
                                                {canOrder
                                                  ? `Order ${orderQty}${orderQty > effectiveShortfall ? " (min)" : ""}`
                                                  : "No stock"}
                                              </Button>
                                            );
                                          })()
                                        ) : (
                                          <Link to="/supply">
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              className="text-xs"
                                            >
                                              Find Vendor
                                            </Button>
                                          </Link>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                            <div className="mt-3 flex justify-end">
                              <CreateProductionOrderDialog
                                disabled={isAgentActive}
                                prefillProductId={p.productId}
                                prefillQty={feasibility?.requestedQty ?? 10}
                                trigger={
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-xs gap-1.5"
                                  >
                                    <Factory className="h-3.5 w-3.5" /> Schedule
                                    Production After Restock
                                  </Button>
                                }
                              />
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                </Accordion>
              )}
            </CardContent>
          </Card>

          {/* Existing Reorder Recommendations */}
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">
                Reorder Recommendations
              </CardTitle>
              <CardDescription>
                Components to reorder within 60 days — total est. cost: $
                {reorder?.estimatedTotalProcurementCost.toFixed(2) ?? "—"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {reorderLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 rounded" />
                  ))}
                </div>
              ) : !reorder?.items.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Package className="mx-auto h-8 w-8 mb-2" />
                  <p>No reorder recommendations — stock is healthy.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reorder.items.map((rec) => (
                    <Card key={rec.componentProductId} className="border">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold">
                                {rec.componentName}
                              </span>
                              {urgencyBadge(rec.urgencyLevel)}
                            </div>
                            <div className="text-xs text-muted-foreground space-x-3">
                              <span>Stock: {rec.currentStock}</span>
                              <span>
                                Stockout in {rec.daysUntilStockout.toFixed(0)}{" "}
                                days
                              </span>
                              <span>
                                Suggested order: {rec.suggestedOrderQty} units
                              </span>
                            </div>
                          </div>
                          {rec.bestVendor && (
                            <div className="text-right">
                              <p className="text-sm font-medium">
                                {rec.bestVendor.vendorName}
                              </p>
                              <p className="text-lg font-bold font-mono">
                                ${rec.bestVendor.totalCost.toFixed(2)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {rec.bestVendor.leadTimeDays}d lead ·{" "}
                                {(rec.bestVendor.reliabilityPct * 100).toFixed(
                                  0,
                                )}
                                % reliable
                              </p>
                              <Button
                                size="sm"
                                className="mt-2"
                                disabled={
                                  !rec.bestVendor.canFulfillOrder ||
                                  orderMutation.isPending
                                }
                                onClick={() =>
                                  orderMutation.mutate({
                                    vendorId: rec.bestVendor!.vendorId,
                                    productId: rec.componentProductId,
                                    qty: rec.suggestedOrderQty,
                                    minOrderQty: 1,
                                    maxOrderQty: rec.suggestedOrderQty,
                                    stockAvailable:
                                      rec.bestVendor!.stockAvailable,
                                  })
                                }
                              >
                                <ShoppingCart className="h-3.5 w-3.5 mr-1" />{" "}
                                Order Now
                              </Button>
                            </div>
                          )}
                        </div>
                        {rec.allVendors.length > 1 && (
                          <div className="mt-3 pt-3 border-t">
                            <p className="text-xs text-muted-foreground mb-2">
                              All vendors ({rec.allVendors.length}):
                            </p>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                              {rec.allVendors.map((av) => (
                                <div
                                  key={av.vendorId}
                                  className="text-xs p-2 rounded bg-muted"
                                >
                                  <span className="font-medium">
                                    {av.vendorName}
                                  </span>
                                  <span className="block">
                                    ${av.totalCost.toFixed(2)} ·{" "}
                                    {av.leadTimeDays}d
                                  </span>
                                  <span
                                    className={`block ${av.canFulfillOrder ? "text-green-600" : "text-red-500"}`}
                                  >
                                    {av.canFulfillOrder
                                      ? "✓ Can fulfill"
                                      : `✗ Stock: ${av.stockAvailable}`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Overstock */}
        <TabsContent value="overstock">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">
                Overstock — Sale Candidates
              </CardTitle>
              <CardDescription>{overstock?.signal}</CardDescription>
            </CardHeader>
            <CardContent>
              {!overstock?.items.length ? (
                <p className="text-muted-foreground text-sm text-center py-6">
                  No overstocked products found.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Sales/30d</TableHead>
                      <TableHead className="text-right">Weeks Supply</TableHead>
                      <TableHead className="text-right">List Price</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overstock.items
                      .sort((a, b) => {
                        const aW =
                          a.weeksOfSupply === -1 ? Infinity : a.weeksOfSupply;
                        const bW =
                          b.weeksOfSupply === -1 ? Infinity : b.weeksOfSupply;
                        return bW - aW;
                      })
                      .slice(0, 30)
                      .map((p) => (
                        <TableRow key={p.productId}>
                          <TableCell className="font-medium">
                            {p.name}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {p.currentStockQty}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {p.salesLast30Days}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {p.weeksOfSupply === -1
                              ? "∞"
                              : p.weeksOfSupply.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            ${p.listPrice.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {(p.grossMarginPct * 100).toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-right">
                            <a
                              href={`https://polite-field-01102b10f.6.azurestaticapps.net/product/${p.productId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button variant="outline" size="sm">
                                <ExternalLink className="h-3 w-3 mr-1" /> Manage
                              </Button>
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Thin Margins */}
        <TabsContent value="margins">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">
                Thin Margin Products — Price Increase Candidates
              </CardTitle>
              <CardDescription>{thinMargin?.signal}</CardDescription>
            </CardHeader>
            <CardContent>
              {!thinMargin?.items.length ? (
                <p className="text-muted-foreground text-sm text-center py-6">
                  All products have healthy margins.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">List Price</TableHead>
                      <TableHead className="text-right">Est. COGS</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead>Signal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {thinMargin.items.map((p) => (
                      <TableRow key={p.productId}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-right font-mono">
                          ${p.listPrice.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${p.estimatedCogs.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono font-bold ${p.grossMarginPct < 0 ? "text-destructive" : ""}`}
                        >
                          {(p.grossMarginPct * 100).toFixed(1)}%
                        </TableCell>
                        <TableCell>{pricingBadge(p.pricingSignal)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default PlanningIntelligence;
