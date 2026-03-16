import React, { useState, useEffect } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  FileText,
  Loader2,
  Eye,
  Mail,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  OrderStatus,
  ORDER_STATUS_WORKFLOW,
  ORDER_STATUS_CONFIG,
  Order,
} from "@/types/order";
import { useAdminOrders, useCancelOrder } from "@/hooks/useAdminOrders";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { getFunctionsApiUrl } from "@/lib/utils";
import ReceiptPreviewModal from "@/components/ReceiptPreviewModal";
import EmailReceiptDialog from "@/components/EmailReceiptDialog";

const OrdersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [dabCursor, setDabCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [searchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<Order | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailOrder, setEmailOrder] = useState<Order | null>(null);
  const [processingOrderId, setProcessingOrderId] = useState<number | null>(
    null,
  );
  const itemsPerPage = 10;

  const { data: apiData, isLoading: ordersLoading } = useAdminOrders(dabCursor);
  const apiOrders = React.useMemo(() => apiData?.items ?? [], [apiData]);
  const cancelOrder = useCancelOrder();

  // Auto-expand order if orderId is in URL params
  useEffect(() => {
    const orderIdParam = searchParams.get("orderId");
    if (orderIdParam) {
      const orderId = parseInt(orderIdParam, 10);
      if (!isNaN(orderId)) {
        setExpandedOrderId(orderId);
        const orderIndex = (apiData?.items ?? []).findIndex(
          (o) => o.SalesOrderID === orderId,
        );
        if (orderIndex !== -1) {
          const page = Math.floor(orderIndex / itemsPerPage) + 1;
          setCurrentPage(page);
        }
      }
    }
  }, [searchParams, apiData]);

  const beginProcessingOrder = async (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setProcessingOrderId(order.SalesOrderID);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/begin-processing-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salesOrderId: order.SalesOrderID }),
        },
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      toast({
        title: `Processing queued — SO${order.SalesOrderID}`,
        description:
          "Order has been queued for processing. Status will update automatically.",
      });
    } catch (err) {
      toast({
        title: "Failed to queue order",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setProcessingOrderId(null);
    }
  };

  const handleCancelOrder = (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    cancelOrder.mutate(order.SalesOrderID, {
      onSuccess: () => {
        toast({
          title: `Order SO${order.SalesOrderID} cancelled`,
          description: "The order has been cancelled.",
        });
      },
      onError: (err) => {
        toast({
          title: "Failed to cancel order",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    });
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const filteredOrders = apiOrders.filter((o) => {
    const matchesSearch =
      o.SalesOrderID.toString().includes(searchQuery) ||
      o.CustomerID.toString().includes(searchQuery);
    const matchesStatus = statusFilter === "all" || o.Status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.ceil(filteredOrders.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedOrders = filteredOrders.slice(
    startIndex,
    startIndex + itemsPerPage,
  );

  const getStatusStyles = (status: OrderStatus) => {
    const config = ORDER_STATUS_CONFIG[status];
    return `${config.bgColor} ${config.color}`;
  };

  const toggleOrderExpand = (orderId: number) => {
    setExpandedOrderId(expandedOrderId === orderId ? null : orderId);
  };

  const handlePreviewReceipt = (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setPreviewOrder(order);
    setPreviewModalOpen(true);
  };

  const handleEmailReceipt = (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setEmailOrder(order);
    setEmailDialogOpen(true);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              Order Management
            </h1>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Search by order # or customer..."
                  className="w-full pl-10 pr-4 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="w-40 font-doodle">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="font-doodle">
                    All Status
                  </SelectItem>
                  {Object.entries(ORDER_STATUS_CONFIG).map(
                    ([status, config]) => (
                      <SelectItem
                        key={status}
                        value={status}
                        className="font-doodle"
                      >
                        {config.icon} {config.label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          <div className="space-y-4">
            {paginatedOrders.map((order) => {
              const statusConfig = ORDER_STATUS_CONFIG[order.Status];
              const nextStatuses = ORDER_STATUS_WORKFLOW[order.Status];
              const isExpanded = expandedOrderId === order.SalesOrderID;

              return (
                <div
                  key={order.SalesOrderID}
                  className="doodle-card overflow-hidden transition-all"
                >
                  {/* Order Header */}
                  <div
                    className="p-4 cursor-pointer hover:bg-doodle-text/5 transition-colors"
                    onClick={() => toggleOrderExpand(order.SalesOrderID)}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex-1">
                        <div>
                          <div className="flex items-center gap-3">
                            <h3 className="font-doodle text-lg font-bold text-doodle-text">
                              Order #{order.SalesOrderID}
                            </h3>
                            <span
                              className={`font-doodle text-xs px-2 py-1 border-2 border-current ${getStatusStyles(order.Status)}`}
                            >
                              {statusConfig.icon} {statusConfig.label}
                            </span>
                          </div>
                          <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                            Customer #{order.CustomerID} •{" "}
                            {new Date(order.OrderDate).toLocaleDateString()}
                          </p>
                          <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                            {order.OrderItems.length} item(s)
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-doodle text-xl font-bold text-doodle-green">
                          ${order.TotalDue.toFixed(2)}
                        </p>
                        {isExpanded ? (
                          <ChevronUp className="w-5 h-5 text-doodle-text/50" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-doodle-text/50" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="border-t-2 border-dashed border-doodle-text/20 p-4 bg-doodle-text/5">
                      {/* Status Workflow */}
                      <div className="mb-6">
                        <h4 className="font-doodle font-bold text-doodle-text mb-3">
                          Order Status Workflow
                        </h4>

                        {/* Visual Workflow Progress */}
                        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
                          {(
                            [
                              "Pending",
                              "Processing",
                              "Shipped",
                              "Delivered",
                            ] as OrderStatus[]
                          ).map((status, index) => {
                            const config = ORDER_STATUS_CONFIG[status];
                            const isCurrent = order.Status === status;
                            const isPast =
                              (order.Status === "Processing" &&
                                status === "Pending") ||
                              (order.Status === "Shipped" &&
                                ["Pending", "Processing"].includes(status)) ||
                              (order.Status === "Delivered" &&
                                ["Pending", "Processing", "Shipped"].includes(
                                  status,
                                ));
                            const isCancelled = order.Status === "Cancelled";

                            return (
                              <React.Fragment key={status}>
                                <div
                                  className={`flex flex-col items-center min-w-[80px] ${
                                    isCancelled ? "opacity-30" : ""
                                  }`}
                                >
                                  <div
                                    className={`w-10 h-10 rounded-full flex items-center justify-center text-lg border-2 ${
                                      isCurrent
                                        ? `${config.bgColor} ${config.color} border-current`
                                        : isPast
                                          ? "bg-doodle-green/20 text-doodle-green border-doodle-green"
                                          : "bg-doodle-text/10 text-doodle-text/40 border-doodle-text/20"
                                    }`}
                                  >
                                    {isPast ? "✓" : config.icon}
                                  </div>
                                  <span
                                    className={`font-doodle text-xs mt-1 ${
                                      isCurrent
                                        ? config.color
                                        : isPast
                                          ? "text-doodle-green"
                                          : "text-doodle-text/40"
                                    }`}
                                  >
                                    {config.label}
                                  </span>
                                </div>
                                {index < 3 && (
                                  <ArrowRight
                                    className={`w-4 h-4 flex-shrink-0 ${
                                      isCancelled
                                        ? "opacity-30"
                                        : isPast ||
                                            (isCurrent &&
                                              status !== "Delivered")
                                          ? "text-doodle-green"
                                          : "text-doodle-text/20"
                                    }`}
                                  />
                                )}
                              </React.Fragment>
                            );
                          })}
                        </div>

                        {order.Status === "Cancelled" && (
                          <div className="flex items-center gap-2 p-3 bg-red-50 border-2 border-red-200 mb-4">
                            <span className="text-xl">❌</span>
                            <span className="font-doodle text-red-700">
                              This order has been cancelled
                            </span>
                          </div>
                        )}

                        {/* Status Actions */}
                        {nextStatuses.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            <span className="font-doodle text-sm text-doodle-text/60 self-center mr-2">
                              Actions:
                            </span>
                            {nextStatuses.includes("Processing") && (
                              <button
                                onClick={(e) => beginProcessingOrder(e, order)}
                                disabled={
                                  processingOrderId === order.SalesOrderID
                                }
                                className="doodle-button doodle-button-primary text-sm py-2 px-4 flex items-center gap-2"
                              >
                                {processingOrderId === order.SalesOrderID ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  ORDER_STATUS_CONFIG["Processing"].icon
                                )}
                                {processingOrderId === order.SalesOrderID
                                  ? "Queueing…"
                                  : `${ORDER_STATUS_CONFIG["Processing"].label}`}
                              </button>
                            )}
                            {nextStatuses.includes("Cancelled") && (
                              <button
                                onClick={(e) => handleCancelOrder(e, order)}
                                disabled={cancelOrder.isPending}
                                className="doodle-button text-sm py-2 px-4 flex items-center gap-2 hover:bg-red-100 hover:text-red-700 hover:border-red-300"
                              >
                                {ORDER_STATUS_CONFIG["Cancelled"].icon} Cancel
                                Order
                              </button>
                            )}
                          </div>
                        )}

                        {nextStatuses.length === 0 && (
                          <p className="font-doodle text-sm text-doodle-text/50 italic">
                            This order is in a final state and cannot be
                            changed.
                          </p>
                        )}
                      </div>

                      {/* Order Items */}
                      <div className="mb-4">
                        <h4 className="font-doodle font-bold text-doodle-text mb-2">
                          Order Items
                        </h4>
                        <div className="space-y-2">
                          {order.OrderItems.map((item) => (
                            <div
                              key={item.SalesOrderDetailID}
                              className="flex justify-between items-center p-2 bg-white border-2 border-dashed border-doodle-text/20"
                            >
                              <div>
                                <span className="font-doodle text-doodle-text">
                                  {item.ProductName}
                                </span>
                                <span className="font-doodle text-xs text-doodle-text/50 ml-2">
                                  × {item.OrderQty}
                                </span>
                              </div>
                              <span className="font-doodle font-bold text-doodle-text">
                                ${item.LineTotal.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Order Summary */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-3 bg-white border-2 border-doodle-text/20">
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">
                            Subtotal
                          </span>
                          <span className="font-doodle font-bold">
                            ${order.SubTotal.toFixed(2)}
                          </span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">
                            Tax
                          </span>
                          <span className="font-doodle font-bold">
                            ${order.TaxAmt.toFixed(2)}
                          </span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">
                            Freight
                          </span>
                          <span className="font-doodle font-bold">
                            ${order.Freight.toFixed(2)}
                          </span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">
                            Total Due
                          </span>
                          <span className="font-doodle font-bold text-doodle-green">
                            ${order.TotalDue.toFixed(2)}
                          </span>
                        </div>
                      </div>

                      {/* Receipt Actions */}
                      <div className="mt-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
                        <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                          <FileText className="w-4 h-4" />
                          Receipt Actions
                        </h4>
                        <div className="flex flex-wrap gap-3">
                          <button
                            onClick={(e) => handlePreviewReceipt(e, order)}
                            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
                          >
                            <Eye className="w-4 h-4" />
                            Preview Receipt
                          </button>
                          <button
                            onClick={(e) => handleEmailReceipt(e, order)}
                            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
                          >
                            <Mail className="w-4 h-4" />
                            Email Receipt
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* DAB page navigation — each page is up to 100 orders */}
          {(cursorStack.length > 0 || apiData?.hasNextPage) && (
            <div className="doodle-card p-4 mt-6 flex items-center justify-between">
              <button
                onClick={() => {
                  const prev = cursorStack[cursorStack.length - 1] ?? null;
                  setCursorStack((s) => s.slice(0, -1));
                  setDabCursor(prev);
                  setCurrentPage(1);
                }}
                disabled={cursorStack.length === 0}
                className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
                aria-label="Previous 100"
              >
                <ChevronLeft className="w-5 h-5" /> Previous 100
              </button>
              <span className="font-doodle text-sm text-doodle-text/60">
                Batch {cursorStack.length + 1}
              </span>
              <button
                onClick={() => {
                  setCursorStack((s) => [...s, dabCursor ?? ""]);
                  setDabCursor(apiData!.endCursor);
                  setCurrentPage(1);
                }}
                disabled={!apiData?.hasNextPage}
                className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
                aria-label="Next 100"
              >
                Next 100 <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {totalPages > 1 && (
            <div className="doodle-card p-4 mt-6 flex items-center justify-center gap-2">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 disabled:opacity-40"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="font-doodle">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() =>
                  setCurrentPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={currentPage === totalPages}
                className="p-2 disabled:opacity-40"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </section>
      </main>
      <Footer />

      <ReceiptPreviewModal
        open={previewModalOpen}
        onOpenChange={setPreviewModalOpen}
        order={previewOrder}
      />

      <EmailReceiptDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        order={emailOrder}
      />
    </div>
  );
};

export default OrdersPage;
