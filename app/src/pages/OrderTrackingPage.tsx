import React, { useState, useEffect } from "react";
import { Link, useParams, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Package,
  CheckCircle,
  Truck,
  MapPin,
  Clock,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useOrders,
  Order,
  getOrderStatusText,
  getOrderStatusColor,
} from "@/hooks/useOrders";
import { getCustomerByPersonId } from "@/lib/customerService";
import { CURRENCY_SYMBOLS } from "@/lib/currencies";

type OrderStatus =
  | "confirmed"
  | "processing"
  | "shipped"
  | "out_for_delivery"
  | "delivered";

interface TrackingStep {
  status: OrderStatus;
  label: string;
  description: string;
  icon: React.ReactNode;
  date?: string;
}

const getOrderStatus = (
  order: Order,
  t: (key: string) => string
): { currentStatus: OrderStatus; steps: TrackingStep[] } => {
  const orderTime = new Date(order.OrderDate).getTime();
  const now = Date.now();
  const daysSinceOrder = Math.floor((now - orderTime) / (1000 * 60 * 60 * 24));

  const baseSteps: TrackingStep[] = [
    {
      status: "confirmed",
      label: t("orderTracking.orderConfirmed"),
      description: t("orderTracking.orderConfirmedDesc"),
      icon: <CheckCircle className="w-6 h-6" />,
    },
    {
      status: "processing",
      label: t("orderTracking.processing"),
      description: t("orderTracking.processingDesc"),
      icon: <Package className="w-6 h-6" />,
    },
    {
      status: "shipped",
      label: t("orderTracking.shipped"),
      description: t("orderTracking.shippedDesc"),
      icon: <Truck className="w-6 h-6" />,
    },
    {
      status: "out_for_delivery",
      label: t("orderTracking.outForDelivery"),
      description: t("orderTracking.outForDeliveryDesc"),
      icon: <MapPin className="w-6 h-6" />,
    },
    {
      status: "delivered",
      label: t("orderTracking.delivered"),
      description: t("orderTracking.deliveredDesc"),
      icon: <CheckCircle className="w-6 h-6" />,
    },
  ];

  // Simulate progress based on days since order
  let currentStatus: OrderStatus = "confirmed";
  const orderDateObj = new Date(order.OrderDate);

  if (daysSinceOrder >= 5) {
    currentStatus = "delivered";
  } else if (daysSinceOrder >= 4) {
    currentStatus = "out_for_delivery";
  } else if (daysSinceOrder >= 2) {
    currentStatus = "shipped";
  } else if (daysSinceOrder >= 1) {
    currentStatus = "processing";
  }

  // Add dates to completed steps
  const steps = baseSteps.map((step, index) => {
    const stepDate = new Date(orderDateObj);
    stepDate.setDate(stepDate.getDate() + index);

    const statusOrder: OrderStatus[] = [
      "confirmed",
      "processing",
      "shipped",
      "out_for_delivery",
      "delivered",
    ];
    const currentIndex = statusOrder.indexOf(currentStatus);
    const stepIndex = statusOrder.indexOf(step.status);

    return {
      ...step,
      date:
        stepIndex <= currentIndex
          ? stepDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : undefined,
    };
  });

  return { currentStatus, steps };
};

const OrderTrackingPage: React.FC = () => {
  const { t } = useTranslation("common");
  const { orderId } = useParams<{ orderId?: string }>();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [customerId, setCustomerId] = useState<number | null>(null);
  const { data: orders = [], isLoading: ordersLoading } = useOrders(
    customerId || 0
  );
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchError, setSearchError] = useState("");

  // Fetch customer ID
  useEffect(() => {
    if (user?.businessEntityId) {
      getCustomerByPersonId(user.businessEntityId).then((customer) => {
        if (customer) {
          setCustomerId(customer.CustomerID);
        }
      });
    }
  }, [user]);

  // Select order by ID from URL parameter
  useEffect(() => {
    if (orderId && orders.length > 0) {
      const found = orders.find((o) => o.SalesOrderNumber === orderId);
      if (found) {
        setSelectedOrder(found);
      }
    }
  }, [orderId, orders]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError("");

    const found = orders.find(
      (o) =>
        o.SalesOrderNumber.toLowerCase() === searchInput.toLowerCase().trim()
    );
    if (found) {
      setSelectedOrder(found);
      setSearchInput("");
    } else {
      setSearchError(t("orderTracking.orderNotFound"));
    }
  };

  if (isLoading || ordersLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-doodle-bg">
        <div className="text-center">
          <span className="text-6xl block mb-4 animate-bounce">📦</span>
          <p className="font-doodle text-doodle-text">
            {t("orderTracking.loading")}
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to="/auth"
        state={{ from: { pathname: "/order-tracking" } }}
        replace
      />
    );
  }

  const { currentStatus, steps } = selectedOrder
    ? getOrderStatus(selectedOrder, t)
    : { currentStatus: "confirmed" as OrderStatus, steps: [] };

  const statusOrder: OrderStatus[] = [
    "confirmed",
    "processing",
    "shipped",
    "out_for_delivery",
    "delivered",
  ];
  const currentIndex = statusOrder.indexOf(currentStatus);

  // Calculate estimated delivery
  const getEstimatedDelivery = (order: Order) => {
    const orderDate = new Date(order.OrderDate);
    orderDate.setDate(orderDate.getDate() + 5);
    return orderDate;
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/account"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("orderTracking.backToAccount")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-3xl mx-auto">
            <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-8 text-center">
              📦 {t("orderTracking.title")}
            </h1>

            {/* Order Search */}
            <div className="doodle-card p-6 mb-8">
              <form
                onSubmit={handleSearch}
                className="flex flex-col sm:flex-row gap-3"
              >
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/40" />
                    <input
                      type="text"
                      value={searchInput}
                      onChange={(e) => {
                        setSearchInput(e.target.value);
                        setSearchError("");
                      }}
                      placeholder={t("orderTracking.searchPlaceholder")}
                      className="doodle-input w-full pl-10"
                    />
                  </div>
                  {searchError && (
                    <p className="font-doodle text-sm text-doodle-accent mt-2">
                      {searchError}
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  className="doodle-button doodle-button-primary"
                >
                  {t("orderTracking.trackOrder")}
                </button>
              </form>

              {orders.length > 0 && !selectedOrder && (
                <div className="mt-6 pt-6 border-t-2 border-dashed border-doodle-text/20">
                  <p className="font-doodle text-sm text-doodle-text/70 mb-3">
                    {t("orderTracking.selectRecent")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {orders.slice(0, 5).map((order) => (
                      <button
                        key={order.SalesOrderID}
                        onClick={() => setSelectedOrder(order)}
                        className="doodle-button text-sm py-1 px-3"
                      >
                        {order.SalesOrderNumber}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Selected Order Tracking */}
            {selectedOrder ? (
              <div className="space-y-6">
                {/* Order Header */}
                <div className="doodle-card p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                      <p className="font-doodle text-sm text-doodle-text/70">
                        {t("orderTracking.orderNumber")}
                      </p>
                      <p className="font-doodle text-xl font-bold text-doodle-accent">
                        {selectedOrder.SalesOrderNumber}
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="font-doodle text-sm text-doodle-text/70">
                        {t("orderTracking.estimatedDelivery")}
                      </p>
                      <p className="font-doodle text-xl font-bold text-doodle-green">
                        {currentStatus === "delivered"
                          ? t("orderTracking.delivered")
                          : getEstimatedDelivery(
                              selectedOrder
                            ).toLocaleDateString("en-US", {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Progress Timeline */}
                <div className="doodle-card p-6 md:p-8">
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-8">
                    {t("orderTracking.shipmentProgress")}
                  </h2>

                  <div className="relative">
                    {/* Progress Line */}
                    <div className="absolute left-[27px] top-0 bottom-0 w-1 bg-doodle-text/20" />
                    <div
                      className="absolute left-[27px] top-0 w-1 bg-doodle-green transition-all duration-500"
                      style={{
                        height: `${(currentIndex / (steps.length - 1)) * 100}%`,
                      }}
                    />

                    {/* Steps */}
                    <div className="space-y-8">
                      {steps.map((step, index) => {
                        const isCompleted = index <= currentIndex;
                        const isCurrent = index === currentIndex;

                        return (
                          <div
                            key={step.status}
                            className="relative flex gap-4"
                          >
                            {/* Icon */}
                            <div
                              className={`
                              relative z-10 w-14 h-14 rounded-full border-4 flex items-center justify-center transition-all
                              ${
                                isCompleted
                                  ? "bg-doodle-green border-doodle-green text-white"
                                  : "bg-doodle-bg border-doodle-text/20 text-doodle-text/40"
                              }
                              ${
                                isCurrent
                                  ? "ring-4 ring-doodle-green/30 animate-pulse"
                                  : ""
                              }
                            `}
                            >
                              {step.icon}
                            </div>

                            {/* Content */}
                            <div className="flex-1 pt-2">
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                                <h3
                                  className={`font-doodle font-bold ${
                                    isCompleted
                                      ? "text-doodle-text"
                                      : "text-doodle-text/50"
                                  }`}
                                >
                                  {step.label}
                                </h3>
                                {step.date && (
                                  <span className="font-doodle text-sm text-doodle-text/50 flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {step.date}
                                  </span>
                                )}
                              </div>
                              <p
                                className={`font-doodle text-sm mt-1 ${
                                  isCompleted
                                    ? "text-doodle-text/70"
                                    : "text-doodle-text/40"
                                }`}
                              >
                                {step.description}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Order Items */}
                <div className="doodle-card p-6">
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4">
                    {t("orderTracking.itemsInOrder")}
                  </h2>
                  <div className="space-y-3">
                    {selectedOrder.salesOrderDetails.items.map(
                      (item, index) => (
                        <div
                          key={`${item.ProductID}-${index}`}
                          className="flex items-center gap-4 p-3 border-2 border-dashed border-doodle-text/20"
                        >
                          <div className="w-12 h-12 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center flex-shrink-0">
                            <span className="font-doodle text-lg">🚴</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-doodle font-bold text-doodle-text truncate">
                              {item.product.Name}
                            </p>
                            <p className="font-doodle text-sm text-doodle-text/70">
                              {t("orderTracking.qty")}: {item.OrderQty}
                            </p>
                          </div>
                          <p className="font-doodle font-bold text-doodle-green">
                            {(selectedOrder.currency?.CurrencyCode &&
                              CURRENCY_SYMBOLS[
                                selectedOrder.currencyRate?.currency
                                  ?.CurrencyCode
                              ]) ||
                              "$"}
                            {item.LineTotal.toFixed(2)}
                          </p>
                        </div>
                      )
                    )}
                  </div>

                  {/* Order Summary */}
                  <div className="mt-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
                    <div className="space-y-1 font-doodle text-sm">
                      <div className="flex justify-between">
                        <span className="text-doodle-text/70">
                          {t("orderTracking.subtotal")}
                        </span>
                        <span>
                          {(selectedOrder.currency?.CurrencyCode &&
                            CURRENCY_SYMBOLS[
                              selectedOrder.currencyRate?.currency?.CurrencyCode
                            ]) ||
                            "$"}
                          {selectedOrder.SubTotal.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-doodle-text/70">
                          {t("orderTracking.tax")}
                        </span>
                        <span>
                          {(selectedOrder.currency?.CurrencyCode &&
                            CURRENCY_SYMBOLS[
                              selectedOrder.currencyRate?.currency?.CurrencyCode
                            ]) ||
                            "$"}
                          {selectedOrder.TaxAmt.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-doodle-text/70">
                          {t("orderTracking.shipping")}
                          {selectedOrder.shipMethod?.Name
                            ? ` (${selectedOrder.shipMethod.Name})`
                            : ""}
                        </span>
                        <span>
                          {(selectedOrder.currency?.CurrencyCode &&
                            CURRENCY_SYMBOLS[
                              selectedOrder.currencyRate?.currency?.CurrencyCode
                            ]) ||
                            "$"}
                          {selectedOrder.Freight.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-dashed border-doodle-text/20 font-bold text-base">
                        <span>{t("orderTracking.total")}</span>
                        <span className="text-doodle-green">
                          {(selectedOrder.currency?.CurrencyCode &&
                            CURRENCY_SYMBOLS[
                              selectedOrder.currencyRate?.currency?.CurrencyCode
                            ]) ||
                            "$"}
                          {selectedOrder.TotalDue.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Order Info */}
                {selectedOrder.Comment && (
                  <div className="doodle-card p-6">
                    <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4">
                      {t("orderTracking.orderNotes")}
                    </h2>
                    <p className="font-doodle text-doodle-text/70">
                      {selectedOrder.Comment}
                    </p>
                  </div>
                )}

                {/* Back Button */}
                <div className="text-center">
                  <button
                    onClick={() => setSelectedOrder(null)}
                    className="doodle-button inline-flex items-center gap-2"
                  >
                    <Search className="w-4 h-4" />
                    {t("orderTracking.trackAnotherOrder")}
                  </button>
                </div>
              </div>
            ) : (
              orders.length === 0 && (
                <div className="doodle-card p-12 text-center">
                  <Package className="w-20 h-20 mx-auto mb-6 text-doodle-text/30" />
                  <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-2">
                    {t("orderTracking.noOrdersYet")}
                  </h2>
                  <p className="font-doodle text-doodle-text/70 mb-6">
                    {t("orderTracking.noOrdersMessage")}
                  </p>
                  <Link
                    to="/"
                    className="doodle-button doodle-button-primary inline-block"
                  >
                    {t("orderTracking.startShopping")}
                  </Link>
                </div>
              )
            )}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default OrderTrackingPage;
