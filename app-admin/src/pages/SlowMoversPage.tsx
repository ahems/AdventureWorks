import React, { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import {
  Package,
  TrendingUp,
  TrendingDown,
  Tag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  DollarSign,
  Clock,
  Layers,
  Edit2,
  Check,
  X,
  AlertTriangle,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { KpiSkeleton, TableSkeleton } from "@/components/LoadingSkeletons";
import ChannelSelector from "@/components/ChannelSelector";
import { useAuth } from "@/context/AuthContext";
import {
  useSlowMoversData,
  type SlowMover,
  type SalesChannel,
} from "@/hooks/useReportingData";
import { useUpdateProductPrice } from "@/hooks/useAdminProducts";
import ClearancePromotionDialog, {
  type ClearanceProduct,
} from "@/components/ClearancePromotionDialog";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(1)}K`
      : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

function daysBadge(days: number | null) {
  if (days === null)
    return (
      <span className="font-doodle text-xs text-doodle-text/40">
        Never sold
      </span>
    );
  if (days > 365)
    return (
      <span className="font-doodle text-xs font-bold text-red-600">
        {days}d
      </span>
    );
  if (days > 180)
    return (
      <span className="font-doodle text-xs font-bold text-orange-600">
        {days}d
      </span>
    );
  return <span className="font-doodle text-xs text-yellow-700">{days}d</span>;
}

type SortKey = keyof Pick<
  SlowMover,
  | "productName"
  | "categoryName"
  | "currentListPrice"
  | "currentCost"
  | "currentStock"
  | "stockValue"
  | "unitsSoldLast12Months"
  | "daysSinceLastSale"
  | "marginPct"
  | "activeDiscounts"
>;

// ─── KPI Card ─────────────────────────────────────────────────────────────────

const KpiCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  variant?: "default" | "warn" | "danger" | "good";
}> = ({ title, value, subtitle, icon, variant = "default" }) => {
  const colours: Record<string, string> = {
    default: "text-doodle-accent",
    warn: "text-yellow-600",
    danger: "text-red-600",
    good: "text-green-600",
  };
  return (
    <div className="doodle-card p-4 flex items-start gap-3">
      <div className={`mt-0.5 ${colours[variant]}`}>{icon}</div>
      <div className="min-w-0">
        <p className="font-doodle text-xs text-doodle-text/60 uppercase tracking-wide">
          {title}
        </p>
        <p className={`font-doodle text-2xl font-bold ${colours[variant]}`}>
          {value}
        </p>
        {subtitle && (
          <p className="font-doodle text-xs text-doodle-text/60 mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
};

// ─── Sort header ──────────────────────────────────────────────────────────────

const SortTh: React.FC<{
  col: SortKey;
  current: SortKey;
  asc: boolean;
  onSort: (col: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}> = ({ col, current, asc, onSort, children, className = "" }) => (
  <th
    className={`px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-yellow-50 ${className}`}
    onClick={() => onSort(col)}
  >
    <span className="inline-flex items-center gap-1">
      {children}
      {current === col ? (
        asc ? (
          <ArrowUp className="w-3 h-3" />
        ) : (
          <ArrowDown className="w-3 h-3" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </span>
  </th>
);

// ─── Page ─────────────────────────────────────────────────────────────────────

const THRESHOLDS = [5, 10, 20, 50] as const;
const PAGE_SIZES = [25, 50, 100] as const;

const SlowMoversPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [threshold, setThreshold] = useState<number>(10);
  const [channel, setChannel] = useState<SalesChannel>("all");
  const { data, isLoading, isError } = useSlowMoversData(threshold, channel);
  const { mutateAsync: updatePrice, isPending: isPriceSaving } =
    useUpdateProductPrice();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("daysSinceLastSale");
  const [sortAsc, setSortAsc] = useState(false);
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0);

  const [editingPrice, setEditingPrice] = useState<{
    productId: number;
    value: string;
  } | null>(null);

  const [clearanceTarget, setClearanceTarget] =
    useState<ClearanceProduct | null>(null);
  const [clearanceDialogOpen, setClearanceDialogOpen] = useState(false);

  // ── derived data ────────────────────────────────────────────────────────────

  const categories = useMemo(() => {
    if (!data) return [] as string[];
    return [
      "all",
      ...Array.from(
        new Set(data.map((d) => d.categoryName ?? "Uncategorised")),
      ).sort(),
    ];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as SlowMover[];
    let rows = data;
    if (categoryFilter !== "all")
      rows = rows.filter(
        (r) => (r.categoryName ?? "Uncategorised") === categoryFilter,
      );
    if (search.trim())
      rows = rows.filter((r) =>
        r.productName.toLowerCase().includes(search.toLowerCase()),
      );
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp =
        typeof av === "string"
          ? (av as string).localeCompare(bv as string)
          : (av as number) - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [data, search, categoryFilter, sortKey, sortAsc]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (col: SortKey) => {
    if (col === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(col);
      setSortAsc(false);
    }
    setPage(0);
  };

  // ── KPI aggregates ───────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    if (!data || data.length === 0) return null;
    const count = data.length;
    const totalStockValue = data.reduce((s, r) => s + r.stockValue, 0);
    const neverSold = data.filter((r) => r.daysSinceLastSale === null).length;
    const noPromo = data.filter((r) => r.activeDiscounts === 0).length;
    return { count, totalStockValue, neverSold, noPromo };
  }, [data]);

  // ── price edit handlers ──────────────────────────────────────────────────────

  const startEdit = (row: SlowMover) => {
    setEditingPrice({
      productId: row.productID,
      value: row.currentListPrice.toFixed(2),
    });
  };

  const cancelEdit = () => setEditingPrice(null);

  const commitEdit = async (productId: number) => {
    if (!editingPrice) return;
    const parsed = parseFloat(editingPrice.value);
    if (isNaN(parsed) || parsed < 0) return;
    await updatePrice({ ProductID: productId, ListPrice: parsed });
    setEditingPrice(null);
  };

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          {/* ── Page header ──────────────────────────────────────────────── */}
          <div className="doodle-card p-6 mb-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
                  <Package className="w-7 h-7 text-yellow-600" />
                  Slow Movers
                </h1>
                <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                  Products with stock on hand that have sold fewer than{" "}
                  <strong>{threshold} units</strong> in the past 12 months.
                  Consider clearance promotions or price reductions.
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <ChannelSelector channel={channel} onChange={setChannel} />
                <div className="flex gap-2 flex-wrap justify-end">
                  <Link
                    to="/loss-makers"
                    className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                  >
                    <TrendingDown className="w-4 h-4" />
                    Loss Makers
                  </Link>
                  <Link
                    to="/product-profitability"
                    className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                  >
                    <TrendingUp className="w-4 h-4" />
                    All Products
                  </Link>
                  <Link
                    to="/promotions"
                    className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                  >
                    <Tag className="w-4 h-4" />
                    Manage Promotions
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* ── Amber callout ────────────────────────────────────────────── */}
          <div className="border-2 border-yellow-400 bg-yellow-50 rounded p-3 mb-6 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
            <p className="font-doodle text-sm text-yellow-800">
              Slow movers tie up capital in unsold stock. Adding a clearance
              promotion or reducing list price can recover value. Use the
              threshold selector to adjust sensitivity.
            </p>
          </div>

          {/* ── Threshold selector ───────────────────────────────────────── */}
          <div className="doodle-card p-3 mb-4 flex items-center gap-3 flex-wrap">
            <span className="font-doodle text-sm text-doodle-text/70">
              Units sold threshold (last 12 months):
            </span>
            <div className="flex items-center gap-2">
              {THRESHOLDS.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setThreshold(t);
                    setPage(0);
                  }}
                  className={`font-doodle text-xs px-3 py-1 border-2 ${
                    threshold === t
                      ? "border-doodle-accent text-doodle-accent font-bold"
                      : "border-doodle-text/30 text-doodle-text/60 hover:border-doodle-text"
                  }`}
                >
                  &lt; {t}
                </button>
              ))}
            </div>
          </div>

          {/* ── KPI cards ─────────────────────────────────────────────────── */}
          {isLoading ? (
            <div className="space-y-6">
              <KpiSkeleton count={4} />
              <TableSkeleton rows={6} cols={7} />
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-24 gap-2 text-red-500">
              <AlertCircle className="w-5 h-5" />
              <span className="font-doodle text-sm">
                Failed to load slow movers data
              </span>
            </div>
          ) : kpis ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <KpiCard
                  title="Slow Movers"
                  value={kpis.count}
                  subtitle={`< ${threshold} units in 12 months`}
                  icon={<Package className="w-5 h-5" />}
                  variant="warn"
                />
                <KpiCard
                  title="Total Stock Value"
                  value={fmt(kpis.totalStockValue)}
                  subtitle="capital tied up"
                  icon={<DollarSign className="w-5 h-5" />}
                  variant="warn"
                />
                <KpiCard
                  title="Never Sold"
                  value={kpis.neverSold}
                  subtitle="no sales on record"
                  icon={<Clock className="w-5 h-5" />}
                  variant={kpis.neverSold > 0 ? "danger" : "good"}
                />
                <KpiCard
                  title="No Promotion"
                  value={kpis.noPromo}
                  subtitle="of slow movers"
                  icon={<Tag className="w-5 h-5" />}
                  variant={kpis.noPromo > 5 ? "warn" : "default"}
                />
              </div>

              {/* ── Filters ───────────────────────────────────────────────── */}
              <div className="doodle-card p-4 mb-4 flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-48">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                    placeholder="Search products…"
                    className="w-full pl-9 pr-3 py-1.5 font-doodle text-sm border-2 border-doodle-text/30 bg-white focus:border-doodle-accent focus:outline-none"
                  />
                </div>
                <select
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setPage(0);
                  }}
                  className="font-doodle text-sm border-2 border-doodle-text/30 bg-white px-2 py-1.5 focus:border-doodle-accent focus:outline-none"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c === "all" ? "All Categories" : c}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <span className="font-doodle text-xs text-doodle-text/60">
                    Show:
                  </span>
                  {PAGE_SIZES.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setPageSize(s);
                        setPage(0);
                      }}
                      className={`font-doodle text-xs px-2 py-1 border-2 ${
                        pageSize === s
                          ? "border-doodle-accent text-doodle-accent"
                          : "border-doodle-text/30 text-doodle-text/60 hover:border-doodle-text"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <span className="font-doodle text-xs text-doodle-text/50">
                  {filtered.length} products
                </span>
              </div>

              {/* ── Table ─────────────────────────────────────────────────── */}
              <div className="doodle-card overflow-hidden mb-4">
                <div
                  className="overflow-x-auto"
                  style={{ transform: "rotateX(180deg)" }}
                >
                  <table
                    className="w-full text-sm"
                    style={{ transform: "rotateX(180deg)" }}
                  >
                    <thead className="bg-yellow-50/50 border-b-2 border-doodle-text/20">
                      <tr>
                        <SortTh
                          col="productName"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                          className="min-w-48"
                        >
                          Product
                        </SortTh>
                        <SortTh
                          col="categoryName"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Category
                        </SortTh>
                        <SortTh
                          col="currentListPrice"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          List Price
                        </SortTh>
                        <SortTh
                          col="currentCost"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Std Cost
                        </SortTh>
                        <SortTh
                          col="marginPct"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Margin
                        </SortTh>
                        <SortTh
                          col="currentStock"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Stock
                        </SortTh>
                        <SortTh
                          col="stockValue"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Stock Value
                        </SortTh>
                        <SortTh
                          col="unitsSoldLast12Months"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Units (12mo)
                        </SortTh>
                        <SortTh
                          col="daysSinceLastSale"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Last Sale
                        </SortTh>
                        <SortTh
                          col="activeDiscounts"
                          current={sortKey}
                          asc={sortAsc}
                          onSort={handleSort}
                        >
                          Promos
                        </SortTh>
                        <th className="px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide whitespace-nowrap min-w-[160px]">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={11}
                            className="py-12 text-center font-doodle text-sm text-doodle-text/50"
                          >
                            {!data || data.length === 0
                              ? "No slow movers at this threshold — great inventory velocity!"
                              : "No results match your search."}
                          </td>
                        </tr>
                      ) : (
                        pageRows.map((row) => {
                          const isEditing =
                            editingPrice?.productId === row.productID;
                          const rowBg =
                            row.daysSinceLastSale === null
                              ? "bg-red-50 hover:bg-red-100/60"
                              : row.daysSinceLastSale > 365
                                ? "bg-orange-50 hover:bg-orange-100/60"
                                : "bg-yellow-50/40 hover:bg-yellow-50";
                          return (
                            <tr
                              key={row.productID}
                              className={`border-b border-doodle-text/10 transition-colors ${rowBg}`}
                            >
                              <td className="px-3 py-2 font-doodle text-xs font-semibold text-doodle-text">
                                <Link
                                  to={`/product/${row.productID}`}
                                  className="hover:text-doodle-accent"
                                >
                                  {row.productName}
                                </Link>
                              </td>
                              <td className="px-3 py-2 font-doodle text-xs text-doodle-text/70">
                                {row.categoryName ?? "—"}
                              </td>

                              {/* Inline price edit */}
                              <td className="px-3 py-2 font-doodle text-xs">
                                {isEditing ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-doodle-text/50">
                                      $
                                    </span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={editingPrice.value}
                                      onChange={(e) =>
                                        setEditingPrice({
                                          productId: row.productID,
                                          value: e.target.value,
                                        })
                                      }
                                      className="w-24 px-1 py-0.5 border-2 border-doodle-accent focus:outline-none font-doodle text-xs"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                          commitEdit(row.productID);
                                        if (e.key === "Escape") cancelEdit();
                                      }}
                                    />
                                    <button
                                      onClick={() => commitEdit(row.productID)}
                                      disabled={isPriceSaving}
                                      className="text-green-600 hover:text-green-700"
                                    >
                                      {isPriceSaving ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Check className="w-3 h-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={cancelEdit}
                                      className="text-red-500 hover:text-red-600"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => startEdit(row)}
                                    className="flex items-center gap-1 text-doodle-text hover:text-doodle-accent group"
                                  >
                                    {fmt(row.currentListPrice)}
                                    <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-60" />
                                  </button>
                                )}
                              </td>

                              <td className="px-3 py-2 font-doodle text-xs text-doodle-text/70">
                                {fmt(row.currentCost)}
                              </td>
                              <td className="px-3 py-2 font-doodle text-xs">
                                {fmtPct(row.marginPct)}
                              </td>
                              <td className="px-3 py-2 font-doodle text-xs text-right text-doodle-text/70">
                                {row.currentStock.toLocaleString()}
                              </td>
                              <td className="px-3 py-2 font-doodle text-xs text-right font-semibold text-yellow-700">
                                {fmt(row.stockValue)}
                              </td>
                              <td className="px-3 py-2 font-doodle text-xs text-right text-doodle-text/70">
                                {row.unitsSoldLast12Months.toLocaleString()}
                              </td>
                              <td className="px-3 py-2">
                                {daysBadge(row.daysSinceLastSale)}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {row.activeDiscounts > 0 ? (
                                  <span className="inline-flex items-center gap-1 text-xs font-doodle text-doodle-accent font-semibold">
                                    <Tag className="w-3 h-3" />
                                    {row.activeDiscounts}
                                  </span>
                                ) : (
                                  <span className="text-xs font-doodle text-doodle-text/30">
                                    —
                                  </span>
                                )}
                              </td>

                              {/* Actions */}
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5 flex-nowrap">
                                  {!isEditing && (
                                    <button
                                      onClick={() => startEdit(row)}
                                      className="doodle-button py-1 px-2 text-xs font-doodle flex items-center gap-1"
                                    >
                                      <Edit2 className="w-3 h-3" />
                                      Price
                                    </button>
                                  )}
                                  <button
                                    onClick={() => {
                                      setClearanceTarget({
                                        productID: row.productID,
                                        productName: row.productName,
                                      });
                                      setClearanceDialogOpen(true);
                                    }}
                                    className="doodle-button py-1 px-2 text-xs font-doodle flex items-center gap-1"
                                    title="Add clearance promotion"
                                  >
                                    <Tag className="w-3 h-3" />
                                    Promo
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── Pagination ────────────────────────────────────────────── */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-doodle text-xs text-doodle-text/50">
                    Page {page + 1} of {totalPages} ({filtered.length} products)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="doodle-button p-1.5 disabled:opacity-40"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="font-doodle text-sm">
                      {page + 1} / {totalPages}
                    </span>
                    <button
                      onClick={() =>
                        setPage((p) => Math.min(totalPages - 1, p + 1))
                      }
                      disabled={page === totalPages - 1}
                      className="doodle-button p-1.5 disabled:opacity-40"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            !isLoading && (
              <div className="doodle-card p-8 text-center">
                <Layers className="w-12 h-12 text-green-500 mx-auto mb-3" />
                <p className="font-doodle text-lg font-bold text-green-700">
                  No slow movers at this threshold!
                </p>
                <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                  All products with stock are selling above the threshold. Try
                  raising the threshold to see more.
                </p>
              </div>
            )
          )}
        </section>
      </main>
      <Footer />

      {/* ── Clearance promotion dialog ────────────────────────────────────────── */}
      <ClearancePromotionDialog
        product={clearanceTarget}
        open={clearanceDialogOpen}
        onOpenChange={(open) => {
          setClearanceDialogOpen(open);
          if (!open) setClearanceTarget(null);
        }}
      />
    </div>
  );
};

export default SlowMoversPage;
