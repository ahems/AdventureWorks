import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Package,
  ChevronDown,
  ChevronRight,
  Clock,
  PlayCircle,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  fetchWorkOrders,
  fetchManufacturedProducts,
  fetchProducts,
  fetchActiveBOM,
  fetchActiveOperations,
} from "@/services/api";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import CreateProductionOrderDialog from "@/components/CreateProductionOrderDialog";
import AgentControlBanner from "@/components/AgentControlBanner";
import { useManufacturingAgentMode } from "@/hooks/useManufacturingAgentMode";
import type { WorkOrder } from "@/types/production";

type WOStatus = "In Progress" | "Planned" | "Completed" | "Scrapped";

const statusColors: Record<string, string> = {
  Planned: "bg-doodle-blue/20 text-doodle-blue border-doodle-blue",
  "In Progress": "bg-doodle-green/20 text-doodle-green border-doodle-green",
  Completed: "bg-secondary text-secondary-foreground border-border",
  Scrapped: "bg-doodle-accent/20 text-doodle-accent border-doodle-accent",
};

const statusIcons: Record<string, React.ReactNode> = {
  Planned: <Clock className="w-3.5 h-3.5" />,
  "In Progress": <PlayCircle className="w-3.5 h-3.5" />,
  Completed: <CheckCircle2 className="w-3.5 h-3.5" />,
  Scrapped: <AlertTriangle className="w-3.5 h-3.5" />,
};

const WORow = ({
  wo,
}: {
  wo: WorkOrder & { status: WOStatus; productName: string };
}) => (
  <tr className="border-b border-doodle-text/10 hover:bg-secondary/30">
    <td className="py-2.5 px-4">
      <Link
        to={`/plan/work-orders/${wo.WorkOrderID}`}
        className="text-doodle-blue hover:underline font-bold"
      >
        {wo.WorkOrderID}
      </Link>
    </td>
    <td className="py-2.5 px-4">
      <Link
        to={`/define/products/${wo.ProductID}`}
        className="hover:text-doodle-accent"
      >
        {wo.productName}
      </Link>
    </td>
    <td className="text-right py-2.5 px-4">{wo.OrderQty}</td>
    <td className="text-right py-2.5 px-4">{wo.StockedQty}</td>
    <td className="text-right py-2.5 px-4">
      {wo.ScrappedQty > 0 ? (
        <span className="text-doodle-accent">{wo.ScrappedQty}</span>
      ) : (
        "0"
      )}
    </td>
    <td className="text-center py-2.5 px-4">
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs border rounded ${statusColors[wo.status]}`}
      >
        {statusIcons[wo.status]} {wo.status}
      </span>
    </td>
    <td className="py-2.5 px-4">
      {new Date(wo.StartDate).toLocaleDateString()}
    </td>
    <td className="py-2.5 px-4">{new Date(wo.DueDate).toLocaleDateString()}</td>
  </tr>
);

const TableHead = () => (
  <thead>
    <tr className="border-b-2 border-doodle-text/20">
      <th className="text-left py-3 px-4">WO #</th>
      <th className="text-left py-3 px-4">Product</th>
      <th className="text-right py-3 px-4">Order Qty</th>
      <th className="text-right py-3 px-4">Stocked</th>
      <th className="text-right py-3 px-4">Scrapped</th>
      <th className="text-center py-3 px-4">Status</th>
      <th className="text-left py-3 px-4">Start</th>
      <th className="text-left py-3 px-4">Due</th>
    </tr>
  </thead>
);

interface ProductGroup {
  productId: number;
  productName: string;
  isFinishedGood: boolean;
  componentCount: number;
  orders: (WorkOrder & { status: WOStatus; productName: string })[];
  totalQty: number;
  statusCounts: Record<string, number>;
  nearestDue: Date;
}

const ProductGroupCard = ({
  group,
  defaultExpanded,
}: {
  group: ProductGroup;
  defaultExpanded?: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  return (
    <div className="doodle-card-static overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <Package
          className={`w-4 h-4 shrink-0 ${group.isFinishedGood ? "text-doodle-blue" : "text-muted-foreground"}`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-doodle text-sm font-bold text-doodle-text truncate">
            <Link
              to={`/define/products/${group.productId}`}
              className="hover:text-doodle-accent"
              onClick={(e) => e.stopPropagation()}
            >
              {group.productName}
            </Link>
            {group.isFinishedGood && (
              <span className="ml-2 text-xs font-normal text-doodle-blue">
                (Finished Good)
              </span>
            )}
            {group.componentCount > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {group.componentCount} components
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 font-doodle text-xs">
          <span className="text-muted-foreground">
            {group.orders.length} WO{group.orders.length !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground">Total: {group.totalQty}</span>
          <div className="flex gap-1">
            {Object.entries(group.statusCounts).map(([status, count]) => (
              <span
                key={status}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 border rounded ${statusColors[status]}`}
              >
                {statusIcons[status]} {count}
              </span>
            ))}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="overflow-x-auto border-t border-doodle-text/10">
          <table className="w-full font-doodle text-sm">
            <TableHead />
            <tbody>
              {group.orders.map((wo) => (
                <WORow key={wo.WorkOrderID} wo={wo} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const tabConfig = [
  {
    value: "active",
    label: "In Progress",
    icon: PlayCircle,
    statuses: ["In Progress"] as WOStatus[],
  },
  {
    value: "upcoming",
    label: "Upcoming",
    icon: Clock,
    statuses: ["Planned"] as WOStatus[],
  },
  {
    value: "completed",
    label: "Completed",
    icon: CheckCircle2,
    statuses: ["Completed", "Scrapped"] as WOStatus[],
  },
];

const PlanWorkOrders = () => {
  const { isAgentActive } = useManufacturingAgentMode();
  const [searchParams] = useSearchParams();
  const initialTab =
    searchParams.get("status") === "Completed" ? "completed" : "active";

  const { data: workOrders, isLoading } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
  });
  const { data: products } = useQuery({
    queryKey: ["manufactured-products"],
    queryFn: fetchManufacturedProducts,
  });
  const { data: allProducts } = useQuery({
    queryKey: ["all-products"],
    queryFn: () => fetchProducts(),
  });
  const { data: activeBom } = useQuery({
    queryKey: ["active-bom"],
    queryFn: fetchActiveBOM,
  });
  // Active ops from simulation — real-time via Web PubSub, 60s fallback
  const { data: activeOps } = useQuery({
    queryKey: ["active-operations"],
    queryFn: fetchActiveOperations,
    refetchInterval: 60_000,
  });

  const productMap = useMemo(() => {
    const map = new Map<number, string>();
    products?.forEach((p) => map.set(p.ProductID, p.Name));
    return map;
  }, [products]);

  const finishedGoodIds = useMemo(() => {
    const s = new Set<number>();
    allProducts?.forEach((p) => {
      if (p.FinishedGoodsFlag) s.add(p.ProductID);
    });
    return s;
  }, [allProducts]);

  const componentCounts = useMemo(() => {
    if (!activeBom) return new Map<number, number>();
    const counts = new Map<number, number>();
    const countComponents = (
      productId: number,
      visited: Set<number>,
    ): number => {
      if (visited.has(productId)) return 0;
      visited.add(productId);
      const children = activeBom.filter(
        (b) => b.ProductAssemblyID === productId,
      );
      let total = children.length;
      for (const c of children) {
        total += countComponents(c.ComponentID, new Set(visited));
      }
      return total;
    };
    const productIds = new Set(
      activeBom
        .map((b) => b.ProductAssemblyID)
        .filter((id): id is number => id != null),
    );
    for (const pid of productIds) {
      counts.set(pid, countComponents(pid, new Set()));
    }
    return counts;
  }, [activeBom]);

  // Build set of work order IDs that the simulation says are actively being worked on
  const activeWoIds = useMemo(() => {
    const s = new Set<number>();
    activeOps?.forEach((op) => s.add(op.workOrderId));
    return s;
  }, [activeOps]);

  // Derive status using simulation truth + database fields
  const getStatus = (wo: WorkOrder): WOStatus => {
    // Scrapped: has scrap qty and nothing stocked
    if (wo.ScrappedQty > 0 && wo.StockedQty === 0) return "Scrapped";
    // Completed: EndDate set OR fully stocked (handles orphaned WOs without EndDate)
    if (wo.EndDate || wo.StockedQty >= wo.OrderQty) return "Completed";
    // In Progress: simulation says this WO has active operations right now
    if (activeWoIds.has(wo.WorkOrderID)) return "In Progress";
    // In Progress: has actual start evidence (StockedQty > 0 but not finished, or ScrappedQty > 0 with remaining)
    if (wo.StockedQty > 0 && wo.StockedQty < wo.OrderQty) return "In Progress";
    // Otherwise it's planned/queued
    return "Planned";
  };

  const enriched = useMemo(
    () =>
      (workOrders || []).map((wo) => ({
        ...wo,
        status: getStatus(wo),
        productName: productMap.get(wo.ProductID) || `#${wo.ProductID}`,
      })),
    [workOrders, productMap, activeWoIds],
  );

  const searchFiltered = enriched;

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      "In Progress": 0,
      Planned: 0,
      Completed: 0,
      Scrapped: 0,
    };
    searchFiltered.forEach((wo) => {
      counts[wo.status] = (counts[wo.status] || 0) + 1;
    });
    return counts;
  }, [searchFiltered]);

  const buildGroups = (
    statuses: WOStatus[],
    sortMode: "due" | "recent" | "complexity",
  ) => {
    const filtered = searchFiltered.filter((wo) =>
      statuses.includes(wo.status),
    );
    const map = new Map<number, ProductGroup>();
    for (const wo of filtered) {
      let g = map.get(wo.ProductID);
      if (!g) {
        g = {
          productId: wo.ProductID,
          productName: wo.productName,
          isFinishedGood: finishedGoodIds.has(wo.ProductID),
          componentCount: componentCounts.get(wo.ProductID) || 0,
          orders: [],
          totalQty: 0,
          statusCounts: {},
          nearestDue: new Date("2099-01-01"),
        };
        map.set(wo.ProductID, g);
      }
      g.orders.push(wo);
      g.totalQty += wo.OrderQty;
      g.statusCounts[wo.status] = (g.statusCounts[wo.status] || 0) + 1;
      const due = new Date(wo.DueDate);
      if (due < g.nearestDue) g.nearestDue = due;
    }

    const groups = [...map.values()];
    groups.forEach((g) => {
      g.orders.sort(
        (a, b) => new Date(a.DueDate).getTime() - new Date(b.DueDate).getTime(),
      );
    });

    if (sortMode === "due") {
      groups.sort((a, b) => a.nearestDue.getTime() - b.nearestDue.getTime());
    } else if (sortMode === "recent") {
      groups.sort((a, b) => {
        const latestA = Math.max(
          ...a.orders.map((o) =>
            new Date(o.EndDate || o.ModifiedDate).getTime(),
          ),
        );
        const latestB = Math.max(
          ...b.orders.map((o) =>
            new Date(o.EndDate || o.ModifiedDate).getTime(),
          ),
        );
        return latestB - latestA;
      });
    } else {
      groups.sort((a, b) => {
        const compA = componentCounts.get(a.productId) || 0;
        const compB = componentCounts.get(b.productId) || 0;
        if (compA !== compB) return compB - compA;
        if (a.isFinishedGood !== b.isFinishedGood)
          return a.isFinishedGood ? -1 : 1;
        return a.productName.localeCompare(b.productName);
      });
    }
    return { groups, total: filtered.length };
  };

  const activeData = useMemo(
    () => buildGroups(["In Progress"], "due"),
    [searchFiltered, finishedGoodIds, componentCounts],
  );
  const upcomingData = useMemo(
    () => buildGroups(["Planned"], "due"),
    [searchFiltered, finishedGoodIds, componentCounts],
  );
  const completedData = useMemo(
    () => buildGroups(["Completed", "Scrapped"], "recent"),
    [searchFiltered, finishedGoodIds, componentCounts],
  );

  const renderTab = (
    data: { groups: ProductGroup[]; total: number },
    defaultExpand: boolean,
  ) => (
    <div className="space-y-2">
      <div className="font-doodle text-xs text-muted-foreground">
        {data.groups.length} products · {data.total} work orders
      </div>
      {data.groups.length === 0 ? (
        <div className="doodle-card-static p-8 text-center font-doodle text-muted-foreground">
          No work orders in this category
        </div>
      ) : (
        data.groups.map((g) => (
          <ProductGroupCard
            key={g.productId}
            group={g}
            defaultExpanded={defaultExpand && data.groups.length <= 5}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <AgentControlBanner />
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">
            3. Plan — Work Orders
          </h1>
          <p className="font-doodle text-sm text-muted-foreground">
            Track production progress — status synced with the shop floor
          </p>
        </div>
        <div className="flex gap-2">
          <CreateProductionOrderDialog disabled={isAgentActive} />
          <Link
            to="/plan/schedule"
            className="doodle-button doodle-button-accent text-sm"
          >
            Schedule View →
          </Link>
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={10} cols={8} />
      ) : (
        <Tabs defaultValue={initialTab} className="space-y-4">
          <TabsList className="font-doodle">
            {tabConfig.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="flex items-center gap-1.5"
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                <span className="ml-1 text-xs opacity-70">
                  (
                  {t.statuses.reduce(
                    (sum, s) => sum + (statusCounts[s] || 0),
                    0,
                  )}
                  )
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="active">
            {renderTab(activeData, true)}
          </TabsContent>
          <TabsContent value="upcoming">
            {renderTab(upcomingData, true)}
          </TabsContent>
          <TabsContent value="completed">
            {renderTab(completedData, false)}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export default PlanWorkOrders;
