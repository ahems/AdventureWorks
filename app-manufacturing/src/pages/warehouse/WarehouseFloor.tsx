import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Button } from "@/components/ui/button";
import {
  Warehouse,
  PackagePlus,
  PackageMinus,
  Truck,
} from "lucide-react";
import {
  fetchWarehouseActive,
  fetchWarehouseStatus,
  type WarehouseActiveOperation,
} from "@/services/warehouseApi";

type FilterType = "all" | "Store" | "Retrieve" | "ReceiveSupplier";

const OP_STYLES: Record<
  string,
  {
    bg: string;
    badge: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  Store: {
    bg: "border-blue-200 bg-blue-50/40",
    badge: "bg-blue-100 text-blue-800",
    icon: PackagePlus,
  },
  Retrieve: {
    bg: "border-green-200 bg-green-50/40",
    badge: "bg-green-100 text-green-800",
    icon: PackageMinus,
  },
  ReceiveSupplier: {
    bg: "border-purple-200 bg-purple-50/40",
    badge: "bg-purple-100 text-purple-800",
    icon: Truck,
  },
};

const OpCard: React.FC<{ op: WarehouseActiveOperation }> = ({ op }) => {
  const style = OP_STYLES[op.operationType] ?? {
    bg: "border-gray-200",
    badge: "bg-gray-100 text-gray-800",
    icon: Warehouse,
  };
  const Icon = style.icon;

  const totalMins = Math.max(
    1,
    (new Date(op.scheduledCompletionUtc).getTime() -
      new Date(op.scheduledStartUtc).getTime()) /
      60000,
  );
  const pct = Math.min(100, (op.elapsedMinutes / totalMins) * 100);
  const remaining = Math.max(0, totalMins - op.elapsedMinutes);

  const labelMap: Record<string, string> = {
    Store: "Store",
    Retrieve: "Retrieve",
    ReceiveSupplier: "Receive",
  };

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${style.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-current" />
          <p className="text-sm font-semibold truncate">{op.productName}</p>
        </div>
        <Badge className={`text-xs shrink-0 ${style.badge}`}>
          {labelMap[op.operationType] ?? op.operationType}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div>
          <p className="font-medium text-foreground">{op.quantity}</p>
          <p>units</p>
        </div>
        <div>
          <p className="font-medium text-foreground">
            {op.assignedWorkerName ?? "—"}
          </p>
          <p>worker</p>
        </div>
        <div>
          <p className="font-medium text-foreground">
            {remaining.toFixed(1)} min
          </p>
          <p>remaining</p>
        </div>
      </div>

      <div className="space-y-0.5">
        <Progress value={pct} className="h-1.5" />
        <p className="text-xs text-muted-foreground text-right">
          {op.elapsedMinutes.toFixed(1)} / {totalMins.toFixed(1)} min
        </p>
      </div>
    </div>
  );
};

const WarehouseFloor: React.FC = () => {
  const [filter, setFilter] = useState<FilterType>("all");

  const { data: status } = useQuery({
    queryKey: ["warehouse-status"],
    queryFn: fetchWarehouseStatus,
    refetchInterval: 60_000,
  });

  const {
    data: active,
    isLoading,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["warehouse-active"],
    queryFn: fetchWarehouseActive,
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    if (!active) return [];
    if (filter === "all") return active;
    return active.filter((op) => op.operationType === filter);
  }, [active, filter]);

  const counts = useMemo(() => {
    const c = { Store: 0, Retrieve: 0, ReceiveSupplier: 0 };
    (active ?? []).forEach((op) => {
      if (op.operationType in c) c[op.operationType as keyof typeof c]++;
    });
    return c;
  }, [active]);

  const filters: { key: FilterType; label: string; count: number }[] = [
    { key: "all", label: "All", count: active?.length ?? 0 },
    { key: "Store", label: "Store", count: counts.Store },
    { key: "Retrieve", label: "Retrieve", count: counts.Retrieve },
    { key: "ReceiveSupplier", label: "Receive", count: counts.ReceiveSupplier },
  ];

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold font-doodle flex items-center gap-2">
            <Warehouse className="h-6 w-6 text-doodle-text" /> Warehouse Floor
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Live operations in progress — real-time updates.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            Queue:{" "}
            <span className="font-semibold text-foreground">
              {status?.queueDepth ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {filters.map(({ key, label, count }) => (
          <Button
            key={key}
            variant={filter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(key)}
            className="gap-1.5"
          >
            {label}
            <Badge variant="secondary" className="text-xs px-1.5 py-0">
              {count}
            </Badge>
          </Button>
        ))}
      </div>

      {/* Operations Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="doodle-border-light">
              <CardContent className="p-3 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-2 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="doodle-border-light">
          <CardContent className="py-16 text-center">
            <Warehouse className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground">
              {filter === "all"
                ? "No active operations — warehouse is idle. Start the manufacturing or supply chain simulator to generate work."
                : `No active ${filter} operations.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((op) => (
            <OpCard key={op.operationId} op={op} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground text-right">
        Last updated:{" "}
        {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "—"}
      </p>
    </div>
  );
};

export default WarehouseFloor;
