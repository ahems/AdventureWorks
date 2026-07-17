import React, { useState, useEffect, useMemo } from "react";
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
  Download,
  CalendarDays,
  X as XIcon,
  Filter,
  Settings,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { useAuth } from "@/context/AuthContext";
import {
  OrderStatus,
  ORDER_STATUS_WORKFLOW,
  ORDER_STATUS_CONFIG,
  Order,
} from "@/types/order";
import {
  useAdminOrders,
  useCancelOrder,
  useShipOrder,
  useOrderById,
  useReceiptStatus,
  orderStatusToDbStatuses,
} from "@/hooks/useAdminOrders";
import {
  useAdminCategories,
  useAdminAllSubcategories,
  useAdminProductsBySubcategory,
  useAdminAllProducts,
} from "@/hooks/useAdminProducts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import { getFunctionsApiUrl } from "@/lib/utils";
import ReceiptPreviewModal from "@/components/ReceiptPreviewModal";
import EmailReceiptDialog from "@/components/EmailReceiptDialog";
import { Sparkles } from "lucide-react";

const ALL_STATUSES = Object.keys(ORDER_STATUS_CONFIG) as OrderStatus[];
const DEFAULT_STATUS_FILTERS: OrderStatus[] = ["Processing"];

const getDefaultDateFrom = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
};
const getDefaultDateTo = (): string => new Date().toISOString().split("T")[0];

interface ReceiptActionsProps {
  order: Order;
  onPreview: (e: React.MouseEvent, order: Order) => void;
  onEmail: (e: React.MouseEvent, order: Order) => void;
  onGenerate: (e: React.MouseEvent, order: Order) => void;
  isGenerating: boolean;
}

const ReceiptActions: React.FC<ReceiptActionsProps> = ({
  order,
  onPreview,
  onEmail,
  onGenerate,
  isGenerating,
}) => {
  const { data: receiptStatus, isLoading: receiptStatusLoading } =
    useReceiptStatus(order.SalesOrderID);

  const downloadUrl = `${getFunctionsApiUrl()}/api/orders/${order.SalesOrderID}/receipt`;

  return (
    <div className="mt-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
      <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
        <FileText className="w-4 h-4" />
        Receipt Actions
      </h4>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={(e) => onPreview(e, order)}
          className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
        >
          <Eye className="w-4 h-4" />
          Preview Receipt
        </button>
        <button
          onClick={(e) => onEmail(e, order)}
          className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
        >
          <Mail className="w-4 h-4" />
          Email Receipt
        </button>
        {receiptStatusLoading ? (
          <button
            disabled
            className="doodle-button flex items-center gap-2 py-2 px-4 opacity-60"
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking…
          </button>
        ) : receiptStatus?.exists ? (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
          >
            <Download className="w-4 h-4" />
            Download Receipt
          </a>
        ) : (
          <button
            onClick={(e) => onGenerate(e, order)}
            disabled={isGenerating}
            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileText className="w-4 h-4" />
            )}
            {isGenerating ? "Generating…" : "Generate Receipt"}
          </button>
        )}
      </div>
    </div>
  );
};

const OrdersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const [orderChannel, setOrderChannel] = useState<"consumer" | "b2b">(
    "consumer",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<OrderStatus[]>(
    DEFAULT_STATUS_FILTERS,
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<Order | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailOrder, setEmailOrder] = useState<Order | null>(null);
  const [processingOrderId, setProcessingOrderId] = useState<number | null>(
    null,
  );
  const [shippingOrderId, setShippingOrderId] = useState<number | null>(null);
  const [generatingReceiptId, setGeneratingReceiptId] = useState<number | null>(
    null,
  );
  const [missingReceiptsCooldown, setMissingReceiptsCooldown] = useState(false);

  // Date filter state — default to last 7 days
  const [dateFrom, setDateFrom] = useState(getDefaultDateFrom);
  const [dateTo, setDateTo] = useState(getDefaultDateTo);

  // Category / subcategory / product filter state
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [subcategoryFilter, setSubcategoryFilter] = useState<number | null>(
    null,
  );
  const [productFilter, setProductFilter] = useState<number | null>(null);

  const itemsPerPage = 10;

  // Data hooks for cascading filters
  const { data: categories = [] } = useAdminCategories();
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const { data: allProducts = [] } = useAdminAllProducts();
  const { data: subcategoryProducts = [] } =
    useAdminProductsBySubcategory(subcategoryFilter);

  // Derived: subcategories for selected category
  const subcategoriesForCategory = useMemo(
    () =>
      categoryFilter
        ? allSubcategories.filter((s) => s.ProductCategoryID === categoryFilter)
        : [],
    [allSubcategories, categoryFilter],
  );

  // Build product→subcategory & product→category lookups
  const productSubcategoryMap = useMemo(
    () =>
      new Map(
        allProducts.map((p) => [p.ProductID, p.ProductSubcategoryID ?? null]),
      ),
    [allProducts],
  );
  const subcategoryCategoryMap = useMemo(
    () =>
      new Map(
        allSubcategories.map((s) => [
          s.ProductSubcategoryID,
          s.ProductCategoryID,
        ]),
      ),
    [allSubcategories],
  );

  // Set of productIds that belong to the selected subcategory
  const subcategoryProductIds = useMemo(
    () => new Set(subcategoryProducts.map((p) => p.ProductID)),
    [subcategoryProducts],
  );

  // Reset sub-filters when parent changes
  useEffect(() => {
    setSubcategoryFilter(null);
    setProductFilter(null);
  }, [categoryFilter]);
  useEffect(() => {
    setProductFilter(null);
  }, [subcategoryFilter]);

  const directOrderIdParam = searchParams.get("orderId");
  const directOrderId = directOrderIdParam
    ? parseInt(directOrderIdParam, 10)
    : null;
  const isDirectLink = directOrderId !== null && !isNaN(directOrderId);

  const dbStatuses = useMemo(
    () => statusFilters.flatMap(orderStatusToDbStatuses),
    [statusFilters],
  );
  const { data: apiOrders = [], isLoading: ordersLoading } = useAdminOrders({
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    statuses: dbStatuses,
  });
  const channelOrders = React.useMemo(
    () =>
      apiOrders.filter(
        (o) => o.OnlineOrderFlag === (orderChannel === "consumer"),
      ),
    [apiOrders, orderChannel],
  );
  const { data: directOrder, isLoading: directOrderLoading } = useOrderById(
    isDirectLink ? directOrderId : null,
  );
  const cancelOrder = useCancelOrder();
  const shipOrder = useShipOrder();

  // Auto-expand the order when coming via direct link
  useEffect(() => {
    if (isDirectLink && directOrderId) {
      setExpandedOrderId(directOrderId);
    }
  }, [isDirectLink, directOrderId]);

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

  const handleShipOrder = async (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setShippingOrderId(order.SalesOrderID);
    try {
      await shipOrder.mutateAsync(order.SalesOrderID);
      toast({
        title: `Shipment queued — SO${order.SalesOrderID}`,
        description:
          "Order has been queued for shipment. Status will update shortly.",
      });
    } catch (err) {
      toast({
        title: "Failed to ship order",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setShippingOrderId(null);
    }
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // When coming from a direct order link, show only that order; otherwise use normal filter
  const filteredOrders = isDirectLink
    ? directOrder
      ? [directOrder]
      : []
    : channelOrders.filter((o) => {
        const matchesSearch =
          o.SalesOrderID.toString().includes(searchQuery) ||
          o.CustomerID.toString().includes(searchQuery);

        const matchesCategory =
          !categoryFilter ||
          o.OrderItems.some((item) => {
            const subId = productSubcategoryMap.get(item.ProductID);
            if (subId == null) return false;
            return subcategoryCategoryMap.get(subId) === categoryFilter;
          });

        const matchesSubcategory =
          !subcategoryFilter ||
          o.OrderItems.some((item) =>
            subcategoryProductIds.has(item.ProductID),
          );

        const matchesProduct =
          !productFilter ||
          o.OrderItems.some((item) => item.ProductID === productFilter);

        return (
          matchesSearch &&
          matchesCategory &&
          matchesSubcategory &&
          matchesProduct
        );
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

  const handleGenerateMissingReceipts = async () => {
    setMissingReceiptsCooldown(true);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/generate-missing-receipts`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      toast({
        title: "Generating missing receipts",
        description: `Up to ${data.estimatedTotal} receipts queued for generation in the background.`,
      });
    } catch (err) {
      toast({
        title: "Failed to start receipt generation",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      // 30-second cooldown prevents flooding the queue before the first batch processes
      setTimeout(() => setMissingReceiptsCooldown(false), 30_000);
    }
  };

  const handleGenerateReceipt = async (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setGeneratingReceiptId(order.SalesOrderID);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/GenerateOrderReceipts_HttpStart`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salesOrderId: order.SalesOrderID }),
        },
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      toast({
        title: `Receipt queued — SO${order.SalesOrderID}`,
        description:
          "Receipt is being generated and will be available shortly.",
      });
    } catch (err) {
      toast({
        title: "Failed to generate receipt",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGeneratingReceiptId(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <h1 className="font-doodle text-3xl font-bold text-doodle-text">
                  Order Management
                </h1>
                {isDirectLink && (
                  <Link
                    to="/orders"
                    className="inline-flex items-center gap-1 font-doodle text-sm text-doodle-accent hover:underline mt-1"
                  >
                    <ArrowLeft className="w-4 h-4" /> Back to all orders
                  </Link>
                )}
                {!isDirectLink && (
                  <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                    {filteredOrders.length} Order
                    {filteredOrders.length !== 1 ? "s" : ""} Shown - showing
                    Orders {startIndex + 1} to{" "}
                    {Math.min(startIndex + itemsPerPage, filteredOrders.length)}
                  </p>
                )}
              </div>
              {!isDirectLink && (
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {/* Channel toggle */}
                  <div className="flex border-2 border-doodle-text overflow-hidden shrink-0">
                    <button
                      onClick={() => {
                        setOrderChannel("consumer");
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1.5 font-doodle text-sm transition-colors ${orderChannel === "consumer" ? "bg-doodle-text text-white" : "bg-white text-doodle-text hover:bg-doodle-text/10"}`}
                    >
                      🛍️ Consumer
                    </button>
                    <button
                      onClick={() => {
                        setOrderChannel("b2b");
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1.5 font-doodle text-sm transition-colors border-l-2 border-doodle-text ${orderChannel === "b2b" ? "bg-doodle-text text-white" : "bg-white text-doodle-text hover:bg-doodle-text/10"}`}
                    >
                      🏢 B2B / Stores
                    </button>
                  </div>
                  <Link
                    to="/generate-order"
                    className="doodle-button doodle-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0"
                  >
                    <Sparkles className="w-4 h-4" />
                    Generate with AI
                  </Link>
                  <button
                    onClick={handleGenerateMissingReceipts}
                    disabled={missingReceiptsCooldown}
                    className="doodle-button flex items-center gap-2 py-2 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {missingReceiptsCooldown ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileText className="w-4 h-4" />
                    )}
                    Generate Missing Receipts
                  </button>
                  <Link
                    to="/order-pipeline"
                    className="doodle-button flex items-center gap-1.5 px-3 py-1.5 text-sm shrink-0"
                    title="Order Pipeline Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </Link>
                </div>
              )}
            </div>
            {!isDirectLink && (
              <div className="flex flex-col gap-3">
                {/* Search + Status row */}
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
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="w-48 font-doodle border-2 border-doodle-text bg-white px-3 py-2 flex items-center justify-between gap-2 hover:bg-doodle-text/5 text-sm">
                        <span className="truncate">
                          {statusFilters.length === ALL_STATUSES.length
                            ? "All Statuses"
                            : statusFilters.length === 0
                              ? "No Status"
                              : statusFilters.length === 1
                                ? `${ORDER_STATUS_CONFIG[statusFilters[0]].icon} ${ORDER_STATUS_CONFIG[statusFilters[0]].label}`
                                : `${statusFilters.length} statuses`}
                        </span>
                        <ChevronDown className="w-4 h-4 flex-shrink-0 text-doodle-text/50" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      className="w-52 p-2 font-doodle"
                    >
                      <div className="space-y-1">
                        <button
                          className="w-full text-left text-xs px-2 py-1 text-doodle-text/60 hover:text-doodle-accent underline"
                          onClick={() =>
                            setStatusFilters(
                              statusFilters.length === ALL_STATUSES.length
                                ? []
                                : [...ALL_STATUSES],
                            )
                          }
                        >
                          {statusFilters.length === ALL_STATUSES.length
                            ? "Deselect all"
                            : "Select all"}
                        </button>
                        {ALL_STATUSES.map((status) => {
                          const config = ORDER_STATUS_CONFIG[status];
                          const checked = statusFilters.includes(status);
                          return (
                            <label
                              key={status}
                              className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-doodle-text/5 rounded select-none"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) => {
                                  setStatusFilters((prev) =>
                                    v
                                      ? [...prev, status]
                                      : prev.filter((s) => s !== status),
                                  );
                                  setCurrentPage(1);
                                }}
                              />
                              <span className="text-sm">
                                {config.icon} {config.label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Date filter row */}
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                  <span className="flex items-center gap-1 font-doodle text-sm text-doodle-text/60 shrink-0">
                    <CalendarDays className="w-4 h-4" /> Date range:
                  </span>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => {
                        setDateFrom(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="font-doodle text-sm border-2 border-doodle-text bg-white px-2 py-1 focus:border-doodle-accent focus:outline-none"
                    />
                    <span className="font-doodle text-sm text-doodle-text/50">
                      to
                    </span>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => {
                        setDateTo(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="font-doodle text-sm border-2 border-doodle-text bg-white px-2 py-1 focus:border-doodle-accent focus:outline-none"
                    />
                    {(dateFrom || dateTo) && (
                      <button
                        onClick={() => {
                          setDateFrom("");
                          setDateTo("");
                          setCurrentPage(1);
                        }}
                        className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent"
                        title="Clear date filter"
                      >
                        <XIcon className="w-3.5 h-3.5" /> Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Cascading category → subcategory → product filter */}
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center flex-wrap">
                  <span className="flex items-center gap-1 font-doodle text-sm text-doodle-text/60 shrink-0">
                    <Filter className="w-4 h-4" /> Category:
                  </span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Category select */}
                    <select
                      value={categoryFilter ?? ""}
                      onChange={(e) => {
                        setCategoryFilter(
                          e.target.value ? Number(e.target.value) : null,
                        );
                        setCurrentPage(1);
                      }}
                      className="font-doodle text-sm border-2 border-doodle-text bg-white px-2 py-1 focus:border-doodle-accent focus:outline-none"
                    >
                      <option value="">All Categories</option>
                      {categories.map((c) => (
                        <option
                          key={c.ProductCategoryID}
                          value={c.ProductCategoryID}
                        >
                          {c.Name}
                        </option>
                      ))}
                    </select>

                    {/* Subcategory select — shown only when category is chosen */}
                    {categoryFilter !== null &&
                      subcategoriesForCategory.length > 0 && (
                        <>
                          <ChevronRight className="w-4 h-4 text-doodle-text/40 shrink-0" />
                          <select
                            value={subcategoryFilter ?? ""}
                            onChange={(e) => {
                              setSubcategoryFilter(
                                e.target.value ? Number(e.target.value) : null,
                              );
                              setCurrentPage(1);
                            }}
                            className="font-doodle text-sm border-2 border-doodle-text bg-white px-2 py-1 focus:border-doodle-accent focus:outline-none"
                          >
                            <option value="">All Subcategories</option>
                            {subcategoriesForCategory.map((s) => {
                              const count = apiOrders.filter((o) =>
                                o.OrderItems.some((item) => {
                                  const subId = productSubcategoryMap.get(
                                    item.ProductID,
                                  );
                                  return subId === s.ProductSubcategoryID;
                                }),
                              ).length;
                              return (
                                <option
                                  key={s.ProductSubcategoryID}
                                  value={s.ProductSubcategoryID}
                                >
                                  {s.Name}
                                  {count > 0 ? ` (${count})` : ""}
                                </option>
                              );
                            })}
                          </select>
                        </>
                      )}

                    {/* Product select — shown only when subcategory is chosen */}
                    {subcategoryFilter !== null &&
                      subcategoryProducts.length > 0 && (
                        <>
                          <ChevronRight className="w-4 h-4 text-doodle-text/40 shrink-0" />
                          <select
                            value={productFilter ?? ""}
                            onChange={(e) => {
                              setProductFilter(
                                e.target.value ? Number(e.target.value) : null,
                              );
                              setCurrentPage(1);
                            }}
                            className="font-doodle text-sm border-2 border-doodle-text bg-white px-2 py-1 focus:border-doodle-accent focus:outline-none"
                          >
                            <option value="">All Products</option>
                            {subcategoryProducts.map((p) => {
                              const count = apiOrders.filter((o) =>
                                o.OrderItems.some(
                                  (item) => item.ProductID === p.ProductID,
                                ),
                              ).length;
                              return (
                                <option key={p.ProductID} value={p.ProductID}>
                                  {p.Name}
                                  {count > 0 ? ` (${count})` : ""}
                                </option>
                              );
                            })}
                          </select>
                        </>
                      )}

                    {/* Clear category filters */}
                    {categoryFilter !== null && (
                      <button
                        onClick={() => {
                          setCategoryFilter(null);
                          setCurrentPage(1);
                        }}
                        className="inline-flex items-center gap-1 font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent"
                        title="Clear category filter"
                      >
                        <XIcon className="w-3.5 h-3.5" /> Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          <div className="space-y-4">
            {(isDirectLink ? directOrderLoading : ordersLoading) && (
              <TableSkeleton rows={5} cols={5} />
            )}
            {isDirectLink &&
              !directOrderLoading &&
              filteredOrders.length === 0 && (
                <div className="doodle-card p-8 text-center font-doodle text-doodle-text/50">
                  Order #{directOrderId} not found.
                </div>
              )}
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
                            <Link
                              to={`/customers?customerId=${order.CustomerID}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-doodle-accent underline decoration-doodle-accent/30 hover:decoration-doodle-accent transition-colors"
                            >
                              Customer #{order.CustomerID}
                            </Link>{" "}
                            • {new Date(order.OrderDate).toLocaleDateString()}
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
                            {nextStatuses.includes("Shipped") && (
                              <button
                                onClick={(e) => handleShipOrder(e, order)}
                                disabled={
                                  shippingOrderId === order.SalesOrderID
                                }
                                className="doodle-button doodle-button-primary text-sm py-2 px-4 flex items-center gap-2 hover:bg-purple-100 hover:text-purple-700 hover:border-purple-300"
                              >
                                {shippingOrderId === order.SalesOrderID ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  ORDER_STATUS_CONFIG["Shipped"].icon
                                )}
                                {shippingOrderId === order.SalesOrderID
                                  ? "Shipping…"
                                  : "Ship Order"}
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
                                <Link
                                  to={`/product/${item.ProductID}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-doodle text-doodle-text hover:text-doodle-accent underline decoration-doodle-accent/30 hover:decoration-doodle-accent transition-colors"
                                >
                                  {item.ProductName}
                                </Link>
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
                      <ReceiptActions
                        order={order}
                        onPreview={handlePreviewReceipt}
                        onEmail={handleEmailReceipt}
                        onGenerate={handleGenerateReceipt}
                        isGenerating={
                          generatingReceiptId === order.SalesOrderID
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Page navigation */}
          {!isDirectLink && totalPages > 1 && (
            <div className="doodle-card p-4 mt-6 flex flex-col gap-3">
              {/* Page nav */}
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="p-2 disabled:opacity-40"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="font-doodle text-sm">
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
