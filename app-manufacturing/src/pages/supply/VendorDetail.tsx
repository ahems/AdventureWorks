import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
} from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Star,
  ShoppingCart,
  Package,
  RefreshCw,
  AlertTriangle,
  Truck,
  Clock,
  Factory,
  ArrowRight,
  ShieldAlert,
  Skull,
} from "lucide-react";
import {
  fetchVendorDetail,
  placeOrder,
  fetchQuote,
  formatIncomingEta,
  formatUtcTime,
  type VendorDetail as VendorDetailType,
  type SupplyQuote,
} from "@/services/supplyChainApi";
import {
  fetchProducts,
  fetchActiveBOM,
  fetchProductInventory,
  fetchProductCategories,
  fetchProductSubcategories,
  fetchPurchaseOrdersByVendor,
  fetchVendorQualityDetail,
  fetchManufacturingStatus,
  type VendorQualityData,
} from "@/services/api";
import type {
  Product,
  BillOfMaterials,
  PurchaseOrderHeader,
} from "@/types/production";
import { toast } from "sonner";
import BlockedWorkOrdersDialog from "@/components/BlockedWorkOrdersDialog";

const VendorDetailPage: React.FC = () => {
  const { vendorId } = useParams<{ vendorId: string }>();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const highlightProductId = searchParams.get("product")
    ? Number(searchParams.get("product"))
    : null;
  const autoOrder = searchParams.get("order") === "1";
  const [orderProductId, setOrderProductId] = useState<number | null>(null);
  const [orderQty, setOrderQty] = useState(1);
  const [quote, setQuote] = useState<SupplyQuote | null>(null);
  const highlightRef = useRef<HTMLTableRowElement>(null);
  const hasScrolled = useRef(false);
  const hasAutoOrdered = useRef(false);
  const [blockedDialog, setBlockedDialog] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const { data, isLoading, error } = useQuery<VendorDetailType>({
    queryKey: ["supply-vendor", vendorId],
    queryFn: () => fetchVendorDetail(vendorId!),
    enabled: !!vendorId,
  });

  const { data: allProducts } = useQuery({
    queryKey: ["products-all"],
    queryFn: () => fetchProducts(),
    staleTime: 120_000,
  });
  const { data: bom } = useQuery({
    queryKey: ["active-bom"],
    queryFn: fetchActiveBOM,
    staleTime: 120_000,
  });
  const { data: inventory } = useQuery({
    queryKey: ["product-inventory"],
    queryFn: () => fetchProductInventory(),
    staleTime: 60_000,
  });

  const { data: sqlPurchaseOrders } = useQuery({
    queryKey: ["vendor-purchase-orders", vendorId],
    queryFn: () => fetchPurchaseOrdersByVendor(parseInt(vendorId!)),
    enabled: !!vendorId,
    staleTime: 30_000,
  });

  // Live manufacturing shortages — used to show how many WOs each component is blocking
  const { data: mfgStatus } = useQuery({
    queryKey: ["manufacturing-status-vendor-detail"],
    queryFn: fetchManufacturingStatus,
    refetchInterval: 5_000,
  });

  const shortageByProduct = useMemo(() => {
    const m = new Map<
      number,
      { blockedWOs: Set<number>; totalShortfall: number }
    >();
    mfgStatus?.shortages?.forEach((s) => {
      if (!m.has(s.productId))
        m.set(s.productId, { blockedWOs: new Set(), totalShortfall: 0 });
      const e = m.get(s.productId)!;
      e.blockedWOs.add(s.workOrderId);
      e.totalShortfall += s.shortfall;
    });
    return m;
  }, [mfgStatus]);
  // Vendor quality data (scrap attributed to this vendor)
  const { data: vendorQualityData } = useQuery<VendorQualityData>({
    queryKey: ["vendor-quality-detail", vendorId],
    queryFn: () => fetchVendorQualityDetail(parseInt(vendorId!)),
    enabled: !!vendorId,
    retry: false, // 404 if no events
  });
  // Auto-scroll to highlighted product row
  useEffect(() => {
    if (highlightRef.current && !hasScrolled.current && data?.stock) {
      hasScrolled.current = true;
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 300);
    }
  }, [data?.stock, highlightProductId]);

  // Find finished goods that depend on this vendor's components
  const finishedGoodsDependents = useMemo(() => {
    if (!data?.stock || !allProducts || !bom) return [];

    const vendorComponentIds = new Set(data.stock.map((s) => s.productId));

    const productMap = new Map<number, Product>();
    allProducts.forEach((p) => productMap.set(p.ProductID, p));

    const bomMap = new Map<number, BillOfMaterials[]>();
    bom.forEach((b) => {
      if (b.ProductAssemblyID != null) {
        const arr = bomMap.get(b.ProductAssemblyID) || [];
        arr.push(b);
        bomMap.set(b.ProductAssemblyID, arr);
      }
    });

    const invMap = new Map<number, number>();
    inventory?.forEach((inv) => {
      invMap.set(
        inv.ProductID,
        (invMap.get(inv.ProductID) || 0) + inv.Quantity,
      );
    });

    const getLeafComponents = (
      productId: number,
      visited = new Set<number>(),
    ): number[] => {
      if (visited.has(productId)) return [];
      visited.add(productId);
      const children = bomMap.get(productId) || [];
      if (children.length === 0) return [productId];
      const result: number[] = [];
      for (const child of children) {
        result.push(...getLeafComponents(child.ComponentID, visited));
      }
      return result;
    };

    const fgProducts = allProducts.filter(
      (p) => p.FinishedGoodsFlag && bomMap.has(p.ProductID),
    );

    return fgProducts
      .map((fg) => {
        const leafIds = getLeafComponents(fg.ProductID);
        const matchingComponents = leafIds.filter((id) =>
          vendorComponentIds.has(id),
        );
        if (matchingComponents.length === 0) return null;
        return {
          product: fg,
          stockOnHand: invMap.get(fg.ProductID) || 0,
          dependentComponents: matchingComponents.map(
            (id) => productMap.get(id)?.Name || `Product ${id}`,
          ),
          totalBomComponents: new Set(leafIds).size,
        };
      })
      .filter(Boolean) as {
      product: Product;
      stockOnHand: number;
      dependentComponents: string[];
      totalBomComponents: number;
    }[];
  }, [data?.stock, allProducts, bom, inventory]);

  const orderMutation = useMutation({
    mutationFn: () => placeOrder(vendorId!, orderProductId!, orderQty),
    onSuccess: (order) => {
      toast.success(
        `Order ${order.orderId} placed — ${order.productName} x${order.qty}`,
      );
      qc.invalidateQueries({ queryKey: ["supply-vendor", vendorId] });
      qc.invalidateQueries({ queryKey: ["supply-orders"] });
      setOrderProductId(null);
      setQuote(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const getQuote = async (productId: number, qty: number) => {
    try {
      const q = await fetchQuote(vendorId!, productId, qty);
      setQuote(q);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const startOrder = (
    productId: number,
    minQty: number,
    stockAvailable: number,
    maxQty: number,
  ) => {
    const needed = shortageByProduct.get(productId)?.totalShortfall ?? 0;
    const cap = Math.min(stockAvailable, maxQty || stockAvailable);
    const desired = needed > 0 ? Math.min(needed, cap) : minQty;
    const qty = Math.max(minQty, desired);
    setOrderProductId(productId);
    setOrderQty(qty);
    setQuote(null);
    getQuote(productId, qty);
  };

  // Auto-open order panel when ?order=1 with ?product=ID
  useEffect(() => {
    if (
      autoOrder &&
      highlightProductId &&
      data?.stock &&
      !hasAutoOrdered.current
    ) {
      const row = data.stock.find((s) => s.productId === highlightProductId);
      if (row && row.stockAvailable > 0) {
        hasAutoOrdered.current = true;
        startOrder(
          row.productId,
          row.minOrderQty,
          row.stockAvailable,
          row.maxOrderQty,
        );
      }
    }
  }, [autoOrder, highlightProductId, data?.stock, shortageByProduct]);

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Card className="border-destructive">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive mb-2" />
            <p>Failed to load vendor details</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const v = data?.vendor?.vendor;

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <Link
        to="/supply"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Supply Chain
      </Link>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : (
        v && (
          <>
            {/* Vendor Header */}
            <Card>
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <h1 className="text-2xl font-bold font-doodle">
                        {v.name}
                      </h1>
                      {v.preferredVendorStatus && (
                        <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      {v.description}
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          Credit Rating
                        </span>
                        <br />
                        <span className="font-bold">{v.creditRating}/5</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Reliability
                        </span>
                        <br />
                        <span className="font-bold">
                          {(v.reliabilityPct * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Avg Lead Time
                        </span>
                        <br />
                        <span className="font-bold">
                          {v.defaultLeadTimeDays} days
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Ship Method
                        </span>
                        <br />
                        <span className="font-bold">{v.shipMethodName}</span>
                      </div>
                    </div>
                    {(v.strengths?.length ?? 0) > 0 && (
                      <div className="flex gap-1 mt-3 flex-wrap">
                        {v.strengths.map((s, i) => (
                          <Badge
                            key={i}
                            variant="secondary"
                            className="text-xs"
                          >
                            {s}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {(v.weaknesses?.length ?? 0) > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {v.weaknesses.map((s, i) => (
                          <Badge
                            key={i}
                            variant="destructive"
                            className="text-xs"
                          >
                            {s}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Order Dialog */}
            {orderProductId && (
              <Card className="border-primary">
                <CardHeader>
                  <CardTitle className="font-doodle text-lg flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5" /> Place Order
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {quote && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm p-4 bg-muted rounded-lg">
                      <div>
                        <span className="text-muted-foreground">Product</span>
                        <br />
                        <span className="font-bold">{quote.productName}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Unit Cost</span>
                        <br />
                        <span className="font-bold">
                          ${quote.unitCost.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Shipping</span>
                        <br />
                        <span className="font-bold">
                          ${quote.shippingCost.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Total</span>
                        <br />
                        <span className="font-bold text-lg">
                          ${quote.totalCost.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">Qty:</span>
                    <Input
                      type="number"
                      value={orderQty}
                      onChange={(e) => {
                        const q = parseInt(e.target.value) || 1;
                        setOrderQty(q);
                        getQuote(orderProductId, q);
                      }}
                      className="w-24"
                      min={quote?.minOrderQty || 1}
                      max={Math.min(quote?.maxOrderQty || 9999, 32767)}
                    />
                    {quote && (
                      <span className="text-xs text-muted-foreground">
                        Min: {quote.minOrderQty} · Max: {quote.maxOrderQty} ·
                        Stock: {quote.stockAvailable}
                      </span>
                    )}
                    <div className="flex-1" />
                    <Button
                      variant="outline"
                      onClick={() => {
                        setOrderProductId(null);
                        setQuote(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => orderMutation.mutate()}
                      disabled={orderMutation.isPending || !quote?.inStock}
                    >
                      {orderMutation.isPending ? (
                        <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Truck className="h-4 w-4 mr-1" />
                      )}
                      Place Order
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Component Stock */}
            <Card>
              <CardHeader>
                <CardTitle className="font-doodle">
                  Component Stock ({data?.stock?.length ?? 0})
                </CardTitle>
                <CardDescription>
                  Available components from this vendor
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Incoming</TableHead>
                      <TableHead className="text-right">ETA</TableHead>
                      <TableHead className="text-right">Blocking</TableHead>
                      <TableHead>Stock Level</TableHead>
                      <TableHead className="text-right">Lead Time</TableHead>
                      <TableHead className="text-right">Min/Max Qty</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.stock
                      ?.slice()
                      .sort((a, b) => {
                        if (highlightProductId) {
                          if (a.productId === highlightProductId) return -1;
                          if (b.productId === highlightProductId) return 1;
                        }
                        const sa =
                          shortageByProduct.get(a.productId)?.blockedWOs.size ??
                          0;
                        const sb =
                          shortageByProduct.get(b.productId)?.blockedWOs.size ??
                          0;
                        if (sa !== sb) return sb - sa;
                        return a.stockAvailable - b.stockAvailable;
                      })
                      .map((s) => {
                        const pct =
                          s.stockAvailable > 0 && s.maxOrderQty > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (s.stockAvailable / s.maxOrderQty) * 100,
                                ),
                              )
                            : 0;
                        const isHighlighted =
                          s.productId === highlightProductId;
                        const sh = shortageByProduct.get(s.productId);
                        const blockedCount = sh?.blockedWOs.size ?? 0;
                        const needed = sh?.totalShortfall ?? 0;
                        return (
                          <TableRow
                            key={s.productId}
                            ref={isHighlighted ? highlightRef : undefined}
                            className={
                              isHighlighted
                                ? "bg-primary/10 ring-1 ring-primary/30"
                                : ""
                            }
                          >
                            <TableCell className="font-medium">
                              {s.productName}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              ${(s.unitCost ?? 0).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {s.stockAvailable}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {s.incomingQty > 0 ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  <Badge
                                    variant="secondary"
                                    className="text-xs font-mono"
                                  >
                                    {s.incomingQty.toLocaleString()} incoming
                                  </Badge>
                                  {s.earliestIncomingEtaUtc && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {formatIncomingEta(
                                        s.earliestIncomingEtaUtc,
                                      )}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground font-mono">
                              {formatUtcTime(s.earliestIncomingEtaUtc)}
                            </TableCell>
                            <TableCell className="text-right">
                              {blockedCount > 0 ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setBlockedDialog({
                                          id: s.productId,
                                          name: s.productName,
                                        })
                                      }
                                      className="inline-flex flex-col items-end gap-0.5 hover:opacity-80 cursor-pointer"
                                    >
                                      <Badge
                                        variant="destructive"
                                        className="text-xs gap-1"
                                      >
                                        <Factory className="h-3 w-3" />{" "}
                                        {blockedCount} WO
                                        {blockedCount !== 1 ? "s" : ""}
                                      </Badge>
                                      <span className="text-[10px] font-mono text-muted-foreground">
                                        need {needed.toLocaleString()}
                                      </span>
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Click to reduce or cancel the {blockedCount}{" "}
                                    blocked work order
                                    {blockedCount !== 1 ? "s" : ""} (
                                    {needed.toLocaleString()} unit
                                    {needed !== 1 ? "s" : ""} needed)
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <span className="text-muted-foreground text-xs">
                                  —
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div>
                                    <Progress
                                      value={pct}
                                      className="h-2 w-20"
                                    />
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {s.stockAvailable.toLocaleString()} in stock
                                  {s.maxOrderQty > 0
                                    ? ` of ${s.maxOrderQty.toLocaleString()} max`
                                    : ""}{" "}
                                  ({pct}%)
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right">
                              {s.leadTimeDays}d
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              {s.minOrderQty}–{s.maxOrderQty}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  startOrder(
                                    s.productId,
                                    s.minOrderQty,
                                    s.stockAvailable,
                                    s.maxOrderQty,
                                  )
                                }
                                disabled={s.stockAvailable === 0}
                              >
                                <ShoppingCart className="h-3.5 w-3.5 mr-1" />{" "}
                                Order
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* SQL Purchase Orders from DAB API */}
            {sqlPurchaseOrders && sqlPurchaseOrders.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-doodle flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5 text-primary" />
                    Purchase Order History ({sqlPurchaseOrders.length})
                  </CardTitle>
                  <CardDescription>
                    Historical purchase orders from the Purchasing database
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>PO #</TableHead>
                        <TableHead>Order Date</TableHead>
                        <TableHead>Ship Date</TableHead>
                        <TableHead className="text-right">SubTotal</TableHead>
                        <TableHead className="text-right">Tax</TableHead>
                        <TableHead className="text-right">Freight</TableHead>
                        <TableHead className="text-right">Total Due</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sqlPurchaseOrders
                        .sort(
                          (a, b) =>
                            new Date(b.OrderDate).getTime() -
                            new Date(a.OrderDate).getTime(),
                        )
                        .slice(0, 50)
                        .map((po) => {
                          const statusLabel =
                            {
                              1: "Pending",
                              2: "Approved",
                              3: "Rejected",
                              4: "Complete",
                            }[po.Status] || `Status ${po.Status}`;
                          const statusClass =
                            {
                              1: "bg-yellow-100 text-yellow-800",
                              2: "bg-blue-100 text-blue-800",
                              3: "bg-red-100 text-red-800",
                              4: "bg-green-100 text-green-800",
                            }[po.Status] || "";
                          return (
                            <TableRow key={po.PurchaseOrderID}>
                              <TableCell>
                                <Link
                                  to={`/supply/orders/${po.PurchaseOrderID}`}
                                  className="font-mono text-sm font-medium text-primary hover:underline"
                                >
                                  #{po.PurchaseOrderID}
                                </Link>
                              </TableCell>
                              <TableCell className="text-sm">
                                {new Date(po.OrderDate).toLocaleDateString()}
                              </TableCell>
                              <TableCell className="text-sm">
                                {po.ShipDate
                                  ? new Date(po.ShipDate).toLocaleDateString()
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                ${po.SubTotal.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                ${po.TaxAmt.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                ${po.Freight.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right font-mono font-medium">
                                ${po.TotalDue.toFixed(2)}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  className={statusClass}
                                  variant="secondary"
                                >
                                  {statusLabel}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Finished Goods Dependent on This Vendor */}
            {finishedGoodsDependents.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-doodle flex items-center gap-2">
                    <Factory className="h-5 w-5 text-primary" />
                    Finished Goods Using These Components (
                    {finishedGoodsDependents.length})
                  </CardTitle>
                  <CardDescription>
                    Products whose Bill of Materials includes components
                    supplied by this vendor
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Finished Good</TableHead>
                        <TableHead className="text-right">Stock</TableHead>
                        <TableHead className="text-right">
                          Components from Vendor
                        </TableHead>
                        <TableHead>Dependent Components</TableHead>
                        <TableHead>BOM</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {finishedGoodsDependents
                        .sort(
                          (a, b) =>
                            b.dependentComponents.length -
                              a.dependentComponents.length ||
                            a.product.Name.localeCompare(b.product.Name),
                        )
                        .map((fg) => (
                          <TableRow key={fg.product.ProductID}>
                            <TableCell className="font-medium">
                              {fg.product.Name}
                            </TableCell>
                            <TableCell className="text-right">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center justify-end gap-1">
                                      <Package className="h-3.5 w-3.5 text-muted-foreground" />
                                      <span
                                        className={`font-mono ${fg.stockOnHand === 0 ? "text-destructive font-medium" : ""}`}
                                      >
                                        {fg.stockOnHand}
                                      </span>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Current finished good inventory
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge
                                variant={
                                  fg.dependentComponents.length >= 3
                                    ? "destructive"
                                    : "secondary"
                                }
                                className="font-mono text-xs"
                              >
                                {fg.dependentComponents.length} /{" "}
                                {fg.totalBomComponents}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1 max-w-sm">
                                {fg.dependentComponents
                                  .slice(0, 4)
                                  .map((name) => (
                                    <Badge
                                      key={name}
                                      variant="outline"
                                      className="text-xs"
                                    >
                                      {name}
                                    </Badge>
                                  ))}
                                {fg.dependentComponents.length > 4 && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    +{fg.dependentComponents.length - 4}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/engineer/bom/${fg.product.ProductID}`}
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs gap-1"
                                >
                                  View BOM{" "}
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </Button>
                              </Link>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Vendor Quality / Scrap Attribution */}
            {vendorQualityData && (
              <Card className="border-destructive/30">
                <CardHeader>
                  <CardTitle className="font-doodle flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-destructive" /> Quality
                    Issues
                  </CardTitle>
                  <CardDescription>
                    {vendorQualityData.totalScrapEvents} scrap event
                    {vendorQualityData.totalScrapEvents !== 1 ? "s" : ""}{" "}
                    attributed to materials from this vendor ·{" "}
                    {vendorQualityData.totalFailures} total failure
                    {vendorQualityData.totalFailures !== 1 ? "s" : ""}·{" "}
                    {vendorQualityData.affectedWorkOrders} work order
                    {vendorQualityData.affectedWorkOrders !== 1 ? "s" : ""}{" "}
                    affected
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center p-3 rounded-lg bg-destructive/5">
                      <p className="text-2xl font-bold font-doodle text-destructive">
                        {vendorQualityData.totalScrapEvents}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Scrap Events
                      </p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-destructive/5">
                      <p className="text-2xl font-bold font-doodle text-destructive">
                        {vendorQualityData.totalFailures}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Total Failures
                      </p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-muted/50">
                      <p className="text-2xl font-bold font-doodle">
                        {vendorQualityData.totalScrapEvents > 0
                          ? Math.round(
                              (vendorQualityData.totalFailures /
                                vendorQualityData.totalScrapEvents) *
                                100,
                            )
                          : 0}
                        %
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Failure Rate
                      </p>
                    </div>
                  </div>
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
                      {vendorQualityData.components
                        .sort((a, b) => b.scrapEvents - a.scrapEvents)
                        .map((c) => (
                          <TableRow key={c.componentProductId}>
                            <TableCell className="font-medium">
                              {c.componentName}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {c.scrapEvents}
                            </TableCell>
                            <TableCell className="text-right font-mono text-destructive font-bold">
                              {c.totalFailures}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {c.scrapEvents > 0
                                ? Math.round(
                                    (c.totalFailures / c.scrapEvents) * 100,
                                  )
                                : 0}
                              %
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground mt-3">
                    <Skull className="h-3 w-3 inline mr-1" />
                    Last event:{" "}
                    {new Date(
                      vendorQualityData.mostRecentEventUtc,
                    ).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )
      )}
      <BlockedWorkOrdersDialog
        open={!!blockedDialog}
        onOpenChange={(o) => !o && setBlockedDialog(null)}
        productId={blockedDialog?.id ?? null}
        productName={blockedDialog?.name ?? ""}
        shortages={mfgStatus?.shortages ?? []}
      />
    </div>
  );
};

export default VendorDetailPage;
