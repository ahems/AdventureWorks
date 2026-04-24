import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  History,
  Archive,
  TrendingUp,
  TrendingDown,
  ShoppingBag,
  Package,
  Filter,
  X,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useTransactionHistory,
  TransactionRecord,
  TransactionType,
  TransactionFilters,
} from "@/hooks/useAdminTransactions";

const TYPE_LABELS: Record<TransactionType, string> = {
  W: "Work Order",
  S: "Sales Order",
  P: "Purchase Order",
};

const TYPE_COLORS: Record<TransactionType, string> = {
  W: "bg-blue-100 text-blue-800 border-blue-300",
  S: "bg-orange-100 text-orange-800 border-orange-300",
  P: "bg-green-100 text-green-800 border-green-300",
};

const TypeBadge: React.FC<{ type: TransactionType }> = ({ type }) => (
  <span
    className={`font-doodle text-xs font-bold px-2 py-0.5 border-2 ${TYPE_COLORS[type]}`}
  >
    {type} — {TYPE_LABELS[type]}
  </span>
);

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatCurrency = (val: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    val,
  );

const InventoryTransactionsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();

  const [showArchive, setShowArchive] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TransactionType | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const currentPage = cursorStack.length - 1;
  const cursor = cursorStack[currentPage];

  const filters: TransactionFilters = useMemo(
    () => ({
      transactionType: typeFilter || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      showArchive,
      cursor,
      pageSize: 50,
    }),
    [typeFilter, dateFrom, dateTo, showArchive, cursor],
  );

  const { data, isLoading, isError } = useTransactionHistory(filters);
  const items: TransactionRecord[] = data?.items ?? [];

  // Summary counts from this page of results (full aggregation would need a separate query)
  const summary = useMemo(() => {
    const produced = items
      .filter((t) => t.TransactionType === "W" && t.Quantity > 0)
      .reduce((s, t) => s + t.Quantity, 0);
    const consumed = items
      .filter((t) => t.TransactionType === "W" && t.Quantity < 0)
      .reduce((s, t) => s + Math.abs(t.Quantity), 0);
    const sold = items
      .filter((t) => t.TransactionType === "S")
      .reduce((s, t) => s + Math.abs(t.Quantity), 0);
    const received = items
      .filter((t) => t.TransactionType === "P")
      .reduce((s, t) => s + t.Quantity, 0);
    return { produced, consumed, sold, received };
  }, [items]);

  const clearFilters = () => {
    setTypeFilter("");
    setDateFrom("");
    setDateTo("");
    setCursorStack([null]);
  };

  const hasActiveFilters = typeFilter || dateFrom || dateTo;

  const goNext = () => {
    if (data?.hasNextPage && data.endCursor) {
      setCursorStack((prev) => [...prev, data.endCursor]);
    }
  };

  const goPrev = () => {
    if (currentPage > 0) {
      setCursorStack((prev) => prev.slice(0, -1));
    }
  };

  // Reset pagination when filters change
  const handleFilterChange = (fn: () => void) => {
    fn();
    setCursorStack([null]);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-doodle-bg flex items-center justify-center">
        <p className="font-doodle text-doodle-text">
          Please log in to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-doodle-bg">
      <AdminHeader />

      <main className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                to="/"
                className="font-doodle text-sm text-doodle-text/60 hover:text-doodle-accent"
              >
                Dashboard
              </Link>
              <span className="font-doodle text-sm text-doodle-text/40">/</span>
              <span className="font-doodle text-sm text-doodle-text">
                Inventory Transactions
              </span>
            </div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
              {showArchive ? (
                <Archive className="w-7 h-7" />
              ) : (
                <History className="w-7 h-7" />
              )}
              {showArchive ? "Transaction Archive" : "Inventory Transactions"}
            </h1>
            <p className="font-doodle text-doodle-text/60 mt-1">
              {showArchive
                ? "Archived inventory movements (records older than 1 year)"
                : "Live inventory movements — W = Work Order, S = Sales Order, P = Purchase Order"}
            </p>
          </div>

          {/* Archive toggle */}
          <button
            onClick={() => handleFilterChange(() => setShowArchive((v) => !v))}
            className={`doodle-button flex items-center gap-2 py-2 px-4 ${showArchive ? "bg-doodle-accent text-white" : ""}`}
          >
            <Archive className="w-4 h-4" />
            {showArchive ? "Show Live Transactions" : "Show Archive"}
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="doodle-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-blue-600" />
              <span className="font-doodle text-xs text-doodle-text/60">
                Produced (W+)
              </span>
            </div>
            <p className="font-doodle text-2xl font-bold text-blue-700">
              {summary.produced.toLocaleString()}
            </p>
            <p className="font-doodle text-xs text-doodle-text/50">
              units on page
            </p>
          </div>
          <div className="doodle-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown className="w-4 h-4 text-yellow-600" />
              <span className="font-doodle text-xs text-doodle-text/60">
                Consumed (W−)
              </span>
            </div>
            <p className="font-doodle text-2xl font-bold text-yellow-700">
              {summary.consumed.toLocaleString()}
            </p>
            <p className="font-doodle text-xs text-doodle-text/50">
              units on page
            </p>
          </div>
          <div className="doodle-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <ShoppingBag className="w-4 h-4 text-orange-600" />
              <span className="font-doodle text-xs text-doodle-text/60">
                Sold (S)
              </span>
            </div>
            <p className="font-doodle text-2xl font-bold text-orange-700">
              {summary.sold.toLocaleString()}
            </p>
            <p className="font-doodle text-xs text-doodle-text/50">
              units on page
            </p>
          </div>
          <div className="doodle-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Package className="w-4 h-4 text-green-600" />
              <span className="font-doodle text-xs text-doodle-text/60">
                Received (P)
              </span>
            </div>
            <p className="font-doodle text-2xl font-bold text-green-700">
              {summary.received.toLocaleString()}
            </p>
            <p className="font-doodle text-xs text-doodle-text/50">
              units on page
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="doodle-card p-4 mb-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-doodle-text/60" />
              <span className="font-doodle text-sm font-bold text-doodle-text">
                Filters
              </span>
            </div>

            {/* Transaction type */}
            <div>
              <label className="font-doodle text-xs text-doodle-text/60 block mb-1">
                Type
              </label>
              <select
                value={typeFilter}
                onChange={(e) =>
                  handleFilterChange(() =>
                    setTypeFilter(e.target.value as TransactionType | ""),
                  )
                }
                className="font-doodle text-sm border-2 border-doodle-text bg-doodle-bg px-2 py-1"
              >
                <option value="">All Types</option>
                <option value="W">W — Work Order</option>
                <option value="S">S — Sales Order</option>
                <option value="P">P — Purchase Order</option>
              </select>
            </div>

            {/* Date from */}
            <div>
              <label className="font-doodle text-xs text-doodle-text/60 block mb-1">
                From Date
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) =>
                  handleFilterChange(() => setDateFrom(e.target.value))
                }
                className="font-doodle text-sm border-2 border-doodle-text bg-doodle-bg px-2 py-1"
              />
            </div>

            {/* Date to */}
            <div>
              <label className="font-doodle text-xs text-doodle-text/60 block mb-1">
                To Date
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) =>
                  handleFilterChange(() => setDateTo(e.target.value))
                }
                className="font-doodle text-sm border-2 border-doodle-text bg-doodle-bg px-2 py-1"
              />
            </div>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="doodle-button flex items-center gap-1 py-1 px-3 text-sm text-doodle-accent"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="doodle-card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center">
              <div className="w-8 h-8 border-4 border-doodle-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="font-doodle text-doodle-text/60">
                Loading transactions…
              </p>
            </div>
          ) : isError ? (
            <div className="p-8 text-center">
              <p className="font-doodle text-red-600">
                Failed to load transactions. Check that the API is available.
              </p>
            </div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center">
              <History className="w-12 h-12 text-doodle-text/20 mx-auto mb-3" />
              <p className="font-doodle text-doodle-text/60">
                No transaction records found.{" "}
                {!showArchive &&
                  "Run a manufacturing or supply chain simulation to generate records."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b-4 border-doodle-text bg-doodle-text/5">
                    <th className="font-doodle text-left text-xs font-bold text-doodle-text/60 px-4 py-3">
                      ID
                    </th>
                    <th className="font-doodle text-left text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Date
                    </th>
                    <th className="font-doodle text-left text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Product
                    </th>
                    <th className="font-doodle text-left text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Type
                    </th>
                    <th className="font-doodle text-right text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Qty
                    </th>
                    <th className="font-doodle text-right text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Unit Cost
                    </th>
                    <th className="font-doodle text-right text-xs font-bold text-doodle-text/60 px-4 py-3">
                      Ref. Order
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((tx) => (
                    <tr
                      key={tx.TransactionID}
                      className="border-b-2 border-dashed border-doodle-text/10 hover:bg-doodle-text/5 transition-colors"
                    >
                      <td className="font-doodle text-xs text-doodle-text/50 px-4 py-3">
                        {tx.TransactionID}
                      </td>
                      <td className="font-doodle text-sm text-doodle-text px-4 py-3 whitespace-nowrap">
                        {formatDate(tx.TransactionDate)}
                      </td>
                      <td className="px-4 py-3">
                        {tx.product ? (
                          <Link
                            to={`/product/${tx.ProductID}`}
                            className="font-doodle text-sm text-doodle-blue hover:underline"
                          >
                            {tx.product.Name}
                            <span className="text-doodle-text/40 ml-1">
                              ({tx.product.ProductNumber})
                            </span>
                          </Link>
                        ) : (
                          <span className="font-doodle text-sm text-doodle-text/50">
                            ID {tx.ProductID}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <TypeBadge type={tx.TransactionType} />
                      </td>
                      <td
                        className={`font-doodle text-sm font-bold text-right px-4 py-3 ${
                          tx.Quantity > 0 ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {tx.Quantity > 0 ? "+" : ""}
                        {tx.Quantity.toLocaleString()}
                      </td>
                      <td className="font-doodle text-sm text-right px-4 py-3 text-doodle-text">
                        {formatCurrency(tx.ActualCost)}
                      </td>
                      <td className="font-doodle text-sm text-right px-4 py-3 text-doodle-text/60">
                        {tx.ReferenceOrderID || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !isError && items.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t-2 border-dashed border-doodle-text/20">
              <span className="font-doodle text-xs text-doodle-text/60">
                Page {currentPage + 1} · {items.length} records
              </span>
              <div className="flex gap-2">
                <button
                  onClick={goPrev}
                  disabled={currentPage === 0}
                  className="doodle-button flex items-center gap-1 py-1 px-3 text-sm disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Prev
                </button>
                <button
                  onClick={goNext}
                  disabled={!data?.hasNextPage}
                  className="doodle-button flex items-center gap-1 py-1 px-3 text-sm disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default InventoryTransactionsPage;
