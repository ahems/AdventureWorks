import React from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  ArrowLeft,
  Truck,
  Package,
  Clock,
  ArrowRight,
  AlertTriangle,
  Star,
  Factory,
  ShoppingCart,
  MapPin,
  DollarSign,
  FileText,
  ExternalLink,
} from "lucide-react";
import {
  fetchOrder,
  fetchVendorDetail,
  type PurchaseOrder,
} from "@/services/supplyChainApi";
import {
  fetchProducts,
  fetchActiveBOM,
  fetchProductInventory,
} from "@/services/api";
import type { Product, BillOfMaterials } from "@/types/production";

const statusColors: Record<string, string> = {
  pending: "bg-blue-100 text-blue-800",
  approved: "bg-indigo-100 text-indigo-800",
  complete: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

const PurchaseOrderDetailPage: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();

  const {
    data: order,
    isLoading,
    error,
  } = useQuery<PurchaseOrder>({
    queryKey: ["supply-order", orderId],
    queryFn: () => fetchOrder(orderId!),
    enabled: !!orderId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "approved" ? 120_000 : false;
    },
  });

  const { data: vendorDetail } = useQuery({
    queryKey: ["supply-vendor", order?.vendorId],
    queryFn: () => fetchVendorDetail(order!.vendorId),
    enabled: !!order?.vendorId,
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

  const v = vendorDetail?.vendor?.vendor;

  // Find finished goods that use this product as a component
  const dependentFinishedGoods = React.useMemo(() => {
    if (!order || !allProducts || !bom) return [];
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

    // Find all assemblies that use this product as a component (direct or indirect)
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
      .filter((fg) => {
        const leafIds = getLeafComponents(fg.ProductID);
        return leafIds.includes(order.productId);
      })
      .map((fg) => ({
        product: fg,
        stockOnHand: invMap.get(fg.ProductID) || 0,
      }));
  }, [order, allProducts, bom, inventory]);

  // Product inventory for ordered product
  const productStock = React.useMemo(() => {
    if (!order || !inventory) return 0;
    return inventory
      .filter((inv) => inv.ProductID === order.productId)
      .reduce((sum, inv) => sum + inv.Quantity, 0);
  }, [order, inventory]);

  const product = allProducts?.find((p) => p.ProductID === order?.productId);

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Card className="border-destructive">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive mb-2" />
            <p>Failed to load purchase order details</p>
            <Link
              to="/supply"
              className="text-primary hover:underline text-sm mt-2 block"
            >
              Back to Supply Chain
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : (
        order && (
          <>
            {/* PO Header */}
            <Card>
              <CardContent className="p-6">
                <div className="flex flex-col md:flex-row items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <h1 className="text-2xl font-bold font-doodle flex items-center gap-2">
                        <FileText className="h-6 w-6 text-primary" />
                        PO #{order.orderId}
                      </h1>
                      <Badge
                        className={`${statusColors[order.status] || ""} text-sm px-3`}
                        variant="secondary"
                      >
                        {order.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Purchase Order for <strong>{order.productName}</strong>{" "}
                      from <strong>{order.vendorName}</strong>
                    </p>
                  </div>
                  {(order.status === "pending" ||
                    order.status === "approved") && (
                    <Badge
                      variant="outline"
                      className="text-xs animate-pulse gap-1"
                    >
                      <Clock className="h-3 w-3" /> Live — refreshing
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Order Details Grid */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Financial Summary */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" /> Financial
                    Details
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Quantity</span>
                      <span className="font-mono font-medium">{order.qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Unit Cost</span>
                      <span className="font-mono">
                        ${order.unitCost.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Shipping</span>
                      <span className="font-mono">
                        ${order.shippingCost.toFixed(2)}
                      </span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-bold">
                      <span>Total Cost</span>
                      <span className="font-mono text-lg">
                        ${order.totalCost.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Timeline */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <Clock className="h-4 w-4 text-primary" /> Timeline
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Placed</span>
                      <span>
                        {new Date(order.placedAtUtc).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Estimated Delivery
                      </span>
                      <span>
                        {new Date(order.estimatedDeliveryUtc).toLocaleString()}
                      </span>
                    </div>
                    {order.actualDeliveryUtc && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Actual Delivery
                        </span>
                        <span className="text-[hsl(var(--doodle-green))] font-medium">
                          {new Date(order.actualDeliveryUtc).toLocaleString()}
                        </span>
                      </div>
                    )}
                    {order.cancellationReason && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Cancellation Reason
                        </span>
                        <span className="text-destructive">
                          {order.cancellationReason}
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Tracking Events */}
            {order.trackingEvents && order.trackingEvents.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <Truck className="h-4 w-4 text-primary" /> Tracking Events
                  </CardTitle>
                  <CardDescription>Timeline of order events</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative pl-6 space-y-4">
                    {order.trackingEvents.map((event, i) => (
                      <div key={i} className="relative">
                        <div className="absolute -left-6 top-1 w-3 h-3 rounded-full bg-primary border-2 border-background" />
                        {i < order.trackingEvents.length - 1 && (
                          <div className="absolute -left-[18px] top-4 w-0.5 h-full bg-border" />
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">
                              {event.eventType}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {new Date(event.timestampUtc).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm mt-0.5">{event.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Quick Links */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Product Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <Package className="h-4 w-4 text-primary" /> Product:{" "}
                    {order.productName}
                  </CardTitle>
                  <CardDescription>
                    Component details and related pages
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      Current Inventory
                    </span>
                    <span
                      className={`font-mono font-medium ${productStock === 0 ? "text-destructive" : ""}`}
                    >
                      {productStock} units
                    </span>
                  </div>
                  {product && (
                    <>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          Product Number
                        </span>
                        <span className="font-mono">
                          {product.ProductNumber}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          Standard Cost
                        </span>
                        <span className="font-mono">
                          ${product.StandardCost.toFixed(2)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="border-t pt-3 flex flex-wrap gap-2">
                    <Link to={`/define/products/${order.productId}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <ExternalLink className="h-3 w-3" /> Product Details
                      </Button>
                    </Link>
                    <Link to={`/receive/inventory/${order.productId}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <MapPin className="h-3 w-3" /> Inventory
                      </Button>
                    </Link>
                    <Link to={`/receive/costing/${order.productId}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <DollarSign className="h-3 w-3" /> Costing
                      </Button>
                    </Link>
                    <Link to={`/supply?product=${order.productId}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <ShoppingCart className="h-3 w-3" /> Other Suppliers
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>

              {/* Vendor Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <Truck className="h-4 w-4 text-primary" /> Vendor:{" "}
                    {order.vendorName}
                    {v?.preferredVendorStatus && (
                      <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                    )}
                  </CardTitle>
                  <CardDescription>Supplier overview and links</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {v && (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <span className="text-muted-foreground">
                            Credit Rating
                          </span>
                          <p className="font-medium">{v.creditRating}/5</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Reliability
                          </span>
                          <p className="font-medium">
                            {(v.reliabilityPct * 100).toFixed(0)}%
                          </p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Lead Time
                          </span>
                          <p className="font-medium">
                            {v.defaultLeadTimeDays} days
                          </p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Ship Method
                          </span>
                          <p className="font-medium">{v.shipMethodName}</p>
                        </div>
                      </div>
                      {v.strengths.length > 0 && (
                        <div className="flex flex-wrap gap-1">
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
                    </>
                  )}
                  <div className="border-t pt-3 flex flex-wrap gap-2">
                    <Link to={`/supply/vendors/${order.vendorId}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <ExternalLink className="h-3 w-3" /> Vendor Page
                      </Button>
                    </Link>
                    <Link
                      to={`/supply/vendors/${order.vendorId}?product=${order.productId}`}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 text-xs"
                      >
                        <Package className="h-3 w-3" /> This Product at Vendor
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Finished Goods that use this component */}
            {dependentFinishedGoods.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-doodle text-base flex items-center gap-2">
                    <Factory className="h-4 w-4 text-primary" /> Finished Goods
                    Using This Component ({dependentFinishedGoods.length})
                  </CardTitle>
                  <CardDescription>
                    Products whose BOM includes {order.productName}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Stock</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dependentFinishedGoods.map((fg) => (
                        <TableRow key={fg.product.ProductID}>
                          <TableCell className="font-medium">
                            {fg.product.Name}
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={`font-mono ${fg.stockOnHand === 0 ? "text-destructive font-medium" : ""}`}
                            >
                              {fg.stockOnHand}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex gap-1 justify-end">
                              <Link
                                to={`/define/products/${fg.product.ProductID}`}
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs gap-1"
                                >
                                  Details <ArrowRight className="h-3 w-3" />
                                </Button>
                              </Link>
                              <Link
                                to={`/engineer/bom/${fg.product.ProductID}`}
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs gap-1"
                                >
                                  BOM <ArrowRight className="h-3 w-3" />
                                </Button>
                              </Link>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )
      )}
    </div>
  );
};

export default PurchaseOrderDetailPage;
