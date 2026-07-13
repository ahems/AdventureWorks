import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { fetchProductCostHistory } from "@/services/api";
import { fetchCurrentCost } from "@/services/planningApi";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import CostNavigator from "./CostNavigator";
import { ChartSkeleton, KpiSkeleton } from "@/components/LoadingSkeletons";

const ReceiveCosting = () => {
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null);

  const { data: costHistory } = useQuery({
    queryKey: ["cost-history", selectedProduct],
    queryFn: () => fetchProductCostHistory(selectedProduct!),
    enabled: !!selectedProduct,
  });
  const {
    data: currentCost,
    isLoading: costLoading,
    isError: costError,
  } = useQuery({
    queryKey: ["current-cost", selectedProduct],
    queryFn: () => fetchCurrentCost(selectedProduct!),
    enabled: !!selectedProduct,
    retry: false,
  });

  const chartData = useMemo(
    () =>
      (costHistory || [])
        .sort(
          (a, b) =>
            new Date(a.StartDate).getTime() - new Date(b.StartDate).getTime(),
        )
        .map((c) => ({
          date: new Date(c.StartDate).toLocaleDateString(),
          cost: c.StandardCost,
        })),
    [costHistory],
  );

  const selectedName = currentCost?.productName;

  const marginColor = (pct: number) =>
    pct > 0.2 ? "text-green-600" : pct > 0 ? "text-yellow-600" : "text-red-600";
  const MarginIcon = (pct: number) =>
    pct > 0.2 ? TrendingUp : pct > 0 ? Minus : TrendingDown;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">
            Cost Analysis
          </h1>
          <p className="font-doodle text-sm text-muted-foreground">
            Historical cost trends & current manufacturing costs
          </p>
        </div>
        <Link to="/receive" className="doodle-button text-sm">
          ← Inventory
        </Link>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Selector */}
        <div>
          <CostNavigator
            selectedProduct={selectedProduct}
            onSelect={setSelectedProduct}
          />
        </div>

        {/* Right panel */}
        <div className="md:col-span-2 space-y-4">
          {!selectedProduct ? (
            <div className="doodle-card-static p-6 flex items-center justify-center h-64">
              <p className="font-doodle text-muted-foreground">
                ← Select a product to view cost analysis
              </p>
            </div>
          ) : costLoading ? (
            <div className="space-y-4">
              <KpiSkeleton count={4} />
              <ChartSkeleton />
            </div>
          ) : costError ? (
            <div className="doodle-card-static p-6 flex flex-col items-center justify-center h-64 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-500 mb-2" />
              <p className="font-doodle text-doodle-text font-bold">
                No cost analysis available
              </p>
              <p className="font-doodle text-sm text-muted-foreground mt-1">
                This product isn't a priced finished good, so a margin breakdown
                can't be computed.
              </p>
            </div>
          ) : (
            <>
              {currentCost?.pricingSignal === "loss-making" && (
                <div className="doodle-card-static p-3 border-l-4 border-destructive bg-destructive/5">
                  <p className="font-doodle text-sm text-doodle-text">
                    <AlertTriangle className="inline w-4 h-4 text-destructive mr-1" />
                    <span className="font-bold text-destructive">
                      Loss-making:
                    </span>{" "}
                    manufacturing cost exceeds list price. See the component
                    breakdown below for the biggest contributors.
                  </p>
                </div>
              )}

              {/* Current Mfg Cost Summary */}
              {currentCost && !costLoading && (
                <div className="doodle-card-static p-4">
                  <h3 className="font-doodle text-sm font-bold text-muted-foreground mb-3">
                    Current Manufacturing Cost
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="text-center">
                      <p className="font-doodle text-xs text-muted-foreground">
                        Material
                      </p>
                      <p className="font-doodle text-lg font-bold text-doodle-text">
                        ${currentCost.currentMaterialCost?.toFixed(2) ?? "—"}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="font-doodle text-xs text-muted-foreground">
                        Routing
                      </p>
                      <p className="font-doodle text-lg font-bold text-doodle-text">
                        ${currentCost.estimatedRoutingCost?.toFixed(2) ?? "—"}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="font-doodle text-xs text-muted-foreground">
                        Total Mfg Cost
                      </p>
                      <p className="font-doodle text-lg font-bold text-primary">
                        ${currentCost.totalManufacturingCost?.toFixed(2) ?? "—"}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="font-doodle text-xs text-muted-foreground">
                        Gross Margin
                      </p>
                      {(() => {
                        const Icon = MarginIcon(
                          currentCost.grossMarginPct ?? 0,
                        );
                        return (
                          <div
                            className={`flex items-center justify-center gap-1 ${marginColor(currentCost.grossMarginPct ?? 0)}`}
                          >
                            <Icon className="h-4 w-4" />
                            <p className="font-doodle text-lg font-bold">
                              {(currentCost.grossMarginPct ?? 0).toFixed(1)}%
                            </p>
                          </div>
                        );
                      })()}
                      <Badge
                        variant={
                          currentCost.pricingSignal === "healthy"
                            ? "default"
                            : currentCost.pricingSignal === "thin-margin"
                              ? "secondary"
                              : "destructive"
                        }
                        className="mt-1 text-[10px]"
                      >
                        {currentCost.pricingSignal}
                      </Badge>
                    </div>
                  </div>
                  {currentCost.listPrice > 0 && (
                    <p className="font-doodle text-xs text-muted-foreground mt-2 text-center">
                      List Price: ${currentCost.listPrice.toFixed(2)} · As of{" "}
                      {new Date(currentCost.costAsOf).toLocaleDateString()}
                    </p>
                  )}
                </div>
              )}

              {/* Chart */}
              <div className="doodle-card-static p-6">
                <h3 className="font-doodle text-lg font-bold text-doodle-text mb-4">
                  {selectedName} — Standard Cost History
                  <Link
                    to={`/receive/costing/${selectedProduct}`}
                    className="text-sm text-doodle-blue font-normal ml-2 hover:underline"
                  >
                    Details →
                  </Link>
                </h3>
                {chartData.length === 0 ? (
                  <p className="font-doodle text-muted-foreground">
                    No cost history records
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={chartData}>
                      <XAxis
                        dataKey="date"
                        tick={{ fontFamily: "Short Stack", fontSize: 11 }}
                      />
                      <YAxis
                        tick={{ fontFamily: "Short Stack", fontSize: 11 }}
                      />
                      <Tooltip contentStyle={{ fontFamily: "Short Stack" }} />
                      <Legend wrapperStyle={{ fontFamily: "Short Stack" }} />
                      <Line
                        type="monotone"
                        dataKey="cost"
                        stroke="hsl(145 45% 35%)"
                        strokeWidth={3}
                        name="Standard Cost"
                        dot={{ r: 4 }}
                      />
                      {currentCost?.totalManufacturingCost != null && (
                        <ReferenceLine
                          y={currentCost.totalManufacturingCost}
                          stroke="hsl(220 70% 50%)"
                          strokeDasharray="6 3"
                          strokeWidth={2}
                          label={{
                            value: `Current Mfg: $${currentCost.totalManufacturingCost.toFixed(2)}`,
                            position: "insideTopRight",
                            fontFamily: "Short Stack",
                            fontSize: 11,
                            fill: "hsl(220 70% 50%)",
                          }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* BOM cost breakdown */}
              {currentCost?.bomBreakdown &&
                currentCost.bomBreakdown.length > 0 && (
                  <div className="doodle-card-static p-4">
                    <h3 className="font-doodle text-sm font-bold text-muted-foreground mb-2">
                      Component Cost Breakdown
                    </h3>
                    <p className="font-doodle text-[11px] text-muted-foreground mb-2">
                      Click the source badge or component name to drill into
                      where the cost figure came from.
                    </p>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {[...currentCost.bomBreakdown]
                        .sort((a, b) => b.costContribution - a.costContribution)
                        .map((line, i) => {
                          const sourceMeta =
                            line.costSource === "ProductCostHistory"
                              ? {
                                  label: "History",
                                  to: `/receive/costing/${line.productId}`,
                                  title:
                                    "Open ProductCostHistory for this component",
                                }
                              : line.costSource ===
                                  "ProductVendor.LastReceiptCost"
                                ? {
                                    label: "POs",
                                    to: `/supply/product/${line.productId}`,
                                    title:
                                      "Open purchase order history for this component",
                                  }
                                : {
                                    label: "Std",
                                    to: `/define/products/${line.productId}`,
                                    title:
                                      "Open product definition (Product.StandardCost)",
                                  };
                          // Manufactured sub-assemblies: drill into their own BOM rollup.
                          // Purchased: drill into purchase-order history so the engineer
                          // can see what we're paying suppliers.
                          const detailTo = line.isPurchased
                            ? `/supply/product/${line.productId}`
                            : `/receive/costing/${line.productId}`;
                          return (
                            <div
                              key={i}
                              className="flex items-center justify-between font-doodle text-xs py-1 border-b border-border/50 last:border-0"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <Link
                                  to={detailTo}
                                  className="text-doodle-text hover:text-doodle-blue hover:underline truncate"
                                  title={
                                    line.isPurchased
                                      ? "See purchase order history & prices paid"
                                      : "Open this sub-assembly cost rollup"
                                  }
                                >
                                  {line.name}
                                </Link>
                                <Link
                                  to={sourceMeta.to}
                                  title={sourceMeta.title}
                                >
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] px-1 hover:bg-secondary/60 cursor-pointer"
                                  >
                                    {sourceMeta.label} →
                                  </Badge>
                                </Link>
                                {!line.isPurchased && (
                                  <Link
                                    to={`/engineer/bom/${line.productId}`}
                                    className="text-[10px] text-doodle-blue hover:underline"
                                    title="Open BOM for this sub-assembly"
                                  >
                                    BOM
                                  </Link>
                                )}
                              </div>
                              <div className="flex gap-3 text-muted-foreground">
                                <span>
                                  {line.requiredPerUnit}× $
                                  {line.currentCost.toFixed(2)}
                                </span>
                                <span className="font-bold text-doodle-text">
                                  ${line.costContribution.toFixed(2)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReceiveCosting;
