import React, { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Tag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertCircle,
  Package,
  ShoppingCart,
  Percent,
  DollarSign,
  Check,
  Edit2,
  X as XIcon,
  Sparkles,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import ChannelSelector from "@/components/ChannelSelector";
import { useAuth } from "@/context/AuthContext";
import {
  useProductProfitabilityDetailData,
  useSalesTrendsData,
  type ProductProfitDetail,
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

type SortKey = keyof Pick<
  ProductProfitDetail,
  | "productName"
  | "categoryName"
  | "profit"
  | "marginPct"
  | "revenue"
  | "currentCost"
  | "currentListPrice"
  | "unitsSold"
  | "currentStock"
  | "currentOrders"
  | "activeDiscounts"
>;

// ─── Margin tier helpers ──────────────────────────────────────────────────────

function marginTier(marginPct: number, profit: number) {
  if (profit < 0) return "negative";
  if (marginPct >= 0.4) return "high";
  if (marginPct >= 0.15) return "medium";
  return "low";
}

function rowBg(tier: string) {
  switch (tier) {
    case "high":
      return "bg-green-50 hover:bg-green-100";
    case "negative":
      return "bg-red-50 hover:bg-red-100";
    case "low":
      return "bg-yellow-50 hover:bg-yellow-100";
    default:
      return "hover:bg-gray-50";
  }
}

function marginBadge(marginPct: number, profit: number) {
  const tier = marginTier(marginPct, profit);
  const label = fmtPct(marginPct);
  switch (tier) {
    case "high":
      return (
        <span className="inline-flex items-center gap-1 text-green-700 font-bold">
          <TrendingUp className="w-3 h-3" />
          {label}
        </span>
      );
    case "negative":
      return (
        <span className="inline-flex items-center gap-1 text-red-600 font-bold">
          <TrendingDown className="w-3 h-3" />
          {label}
        </span>
      );
    case "low":
      return (
        <span className="inline-flex items-center gap-1 text-yellow-700 font-bold">
          <AlertTriangle className="w-3 h-3" />
          {label}
        </span>
      );
    default:
      return <span className="font-bold">{label}</span>;
  }
}

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

// ─── Sort header cell ─────────────────────────────────────────────────────────

const SortTh: React.FC<{
  col: SortKey;
  current: SortKey;
  asc: boolean;
  onSort: (col: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}> = ({ col, current, asc, onSort, children, className = "" }) => (
  <th
    className={`px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 ${className}`}
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

// ─── Sales Trend Panel (lazy fetch per product) ────────────────────────────────

const SalesTrendPanel: React.FC<{ productId: number }> = ({ productId }) => {
  const { data, isLoading } = useSalesTrendsData(productId);
  if (isLoading)
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin text-doodle-accent" />
      </div>
    );
  if (!data || data.length === 0)
    return (
      <p className="font-doodle text-xs text-doodle-text/50 py-2">
        No sales data in the last 12 months.
      </p>
    );
  const chartData = data.map((d) => ({
    label: `${d.year}-${String(d.month).padStart(2, "0")}`,
    units: d.unitsSold,
    revenue: d.revenue,
  }));
  return (
    <div className="flex gap-6 items-start py-2 flex-wrap">
      <div className="flex-1 min-w-[180px]">
        <p className="font-doodle text-xs text-doodle-text/60 mb-1 uppercase tracking-wide">
          Units Sold (12 months)
        </p>
        <ResponsiveContainer width="100%" height={56}>
          <LineChart
            data={chartData}
            margin={{ top: 2, right: 4, bottom: 2, left: 0 }}
          >
            <Line
              type="monotone"
              dataKey="units"
              stroke="hsl(var(--doodle-accent))"
              strokeWidth={2}
              dot={false}
            />
            <XAxis dataKey="label" hide />
            <YAxis hide />
            <Tooltip
              formatter={(v: number) => [v, "Units"]}
              contentStyle={{ fontFamily: "inherit", fontSize: 11 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 min-w-[180px]">
        <p className="font-doodle text-xs text-doodle-text/60 mb-1 uppercase tracking-wide">
          Revenue (12 months)
        </p>
        <ResponsiveContainer width="100%" height={56}>
          <LineChart
            data={chartData}
            margin={{ top: 2, right: 4, bottom: 2, left: 0 }}
          >
            <Line
              type="monotone"
              dataKey="revenue"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
            />
            <XAxis dataKey="label" hide />
            <YAxis hide />
            <Tooltip
              formatter={(v: number) => [
                `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
                "Revenue",
              ]}
              contentStyle={{ fontFamily: "inherit", fontSize: 11 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const PAGE_SIZES = [25, 50, 100] as const;

const ProductProfitabilityPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [channel, setChannel] = useState<SalesChannel>("all");
  const { data, isLoading, isError } = useProductProfitabilityDetailData(channel);
  const { mutateAsync: updatePrice, isPending: isPriceSaving } =
    useUpdateProductPrice();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortAsc, setSortAsc] = useState(false);
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0);
  const [editingPrice, setEditingPrice] = useState<{
    productId: number;
    value: string;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<"all" | "opportunities">("all");
  const [expandedProductId, setExpandedProductId] = useState<number | null>(
    null,
  );
  const [clearanceTarget, setClearanceTarget] =
    useState<ClearanceProduct | null>(null);
  const [clearanceDialogOpen, setClearanceDialogOpen] = useState(false);

  // ── derived data ────────────────────────────────────────────────────────────

  const categories = useMemo(() => {
    if (!data) return [] as string[];
    return [
      "all",
      ...Array.from(new Set(data.map((d) => d.categoryName))).sort(),
    ];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as ProductProfitDetail[];
    let rows = data;
    if (categoryFilter !== "all")
      rows = rows.filter((r) => r.categoryName === categoryFilter);
    if (search.trim())
      rows = rows.filter((r) =>
        r.productName.toLowerCase().includes(search.toLowerCase()),
      );
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "string"
          ? (av as string).localeCompare(bv as string)
          : (av as number) - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [data, search, categoryFilter, sortKey, sortAsc]);

  const opportunities = useMemo(() => {
    if (!data) return [] as ProductProfitDetail[];
    return data.filter(
      (r) =>
        (r.marginPct >= 0.3 && r.activeDiscounts === 0 && r.unitsSold > 0) ||
        (r.currentStock >= 50 && r.unitsSold < 10),
    );
  }, [data]);

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

  const handleSearch = (v: string) => {
    setSearch(v);
    setPage(0);
  };
  const handleCategory = (v: string) => {
    setCategoryFilter(v);
    setPage(0);
  };

  // ── price edit handlers ──────────────────────────────────────────────────────

  const startPriceEdit = (row: ProductProfitDetail) => {
    setEditingPrice({
      productId: row.productID,
      value: row.currentListPrice.toFixed(2),
    });
  };

  const cancelPriceEdit = () => setEditingPrice(null);

  const commitPriceEdit = async (productId: number) => {
    if (!editingPrice) return;
    const parsed = parseFloat(editingPrice.value);
    if (isNaN(parsed) || parsed < 0) return;
    await updatePrice({ ProductID: productId, ListPrice: parsed });
    setEditingPrice(null);
  };

  // ── KPI aggregates ───────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    if (!data) return null;
    const total = data.length;
    const totalProfit = data.reduce((s, r) => s + r.profit, 0);
    const avgMargin =
      data.length > 0
        ? data.reduce((s, r) => s + r.marginPct, 0) / data.length
        : 0;
    const negativeCount = data.filter((r) => r.profit < 0).length;
    const noPromoCount = data.filter((r) => r.activeDiscounts === 0).length;
    return { total, totalProfit, avgMargin, negativeCount, noPromoCount };
  }, [data]);

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
                  <TrendingUp className="w-7 h-7 text-doodle-accent" />
                  Product Profitability
                </h1>
                <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                  Full product-level profit, margin, stock, and promotional
                  status. Use this view to identify products that need attention
                  or promotion to maximise revenue.
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <ChannelSelector channel={channel} onChange={setChannel} />
                <div className="flex gap-2 flex-wrap justify-end">
                <Link
                  to="/reports"
                  className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                >
                  <BarChart3 className="w-4 h-4" />
                  View Reports
                </Link>
                <Link
                  to="/promotions"
                  className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                >
                  <Tag className="w-4 h-4" />
                  Manage Promotions
                </Link>
                <Link
                  to="/products"
                  className="doodle-button inline-flex items-center gap-2 font-doodle text-sm"
                >
                  <Package className="w-4 h-4" />
                  View Products
                </Link>
                </div>
              </div>
          </div>

          {/* ── KPI cards ─────────────────────────────────────────────────── */}
          {isLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="w-6 h-6 animate-spin text-doodle-accent" />
              <span className="ml-2 font-doodle text-sm text-doodle-text/60">
                Loading data…
              </span>
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-24 gap-2 text-red-500">
              <AlertCircle className="w-5 h-5" />
              <span className="font-doodle text-sm">
                Failed to load profitability data
              </span>
            </div>
          ) : kpis ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
                <KpiCard
                  title="Products Analysed"
                  value={kpis.total.toLocaleString()}
                  icon={<Package className="w-5 h-5" />}
                />
                <KpiCard
                  title="Total Profit (All Time)"
                  value={fmt(kpis.totalProfit)}
                  icon={<DollarSign className="w-5 h-5" />}
                  variant="good"
                />
                <KpiCard
                  title="Average Gross Margin"
                  value={fmtPct(kpis.avgMargin)}
                  icon={<Percent className="w-5 h-5" />}
                  variant={
                    kpis.avgMargin >= 0.3
                      ? "good"
                      : kpis.avgMargin >= 0.1
                        ? "default"
                        : "warn"
                  }
                />
                <Link
                  to="/loss-makers"
                  className="block hover:opacity-90 transition-opacity"
                >
                  <KpiCard
                    title="Negative Profit"
                    value={kpis.negativeCount}
                    subtitle="click to view loss makers →"
                    icon={<TrendingDown className="w-5 h-5" />}
                    variant={kpis.negativeCount > 0 ? "danger" : "good"}
                  />
                </Link>
                <Link
                  to="/promotions"
                  className="block hover:opacity-90 transition-opacity"
                >
                  <KpiCard
                    title="No Active Promotion"
                    value={kpis.noPromoCount}
                    subtitle="click to manage promotions →"
                    icon={<Tag className="w-5 h-5" />}
                    variant={kpis.noPromoCount > 20 ? "warn" : "default"}
                  />
                </Link>
              </div>

              {/* ── Margin legend ──────────────────────────────────────────── */}
              <div className="doodle-card p-3 mb-4 flex flex-wrap gap-4 items-center font-doodle text-xs text-doodle-text/70">
                <span className="font-bold">Row colours:</span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-green-100 border border-green-300 inline-block" />
                  High margin ≥ 40%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-white border border-gray-300 inline-block" />
                  Medium 15–40%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-yellow-100 border border-yellow-300 inline-block" />
                  Low &lt; 15%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-red-100 border border-red-300 inline-block" />
                  Negative profit
                </span>
              </div>

              {/* ── Filters ───────────────────────────────────────────────── */}
              <div className="doodle-card p-4 mb-4 flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-48">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search products…"
                    value={search}
                    onChange={(e) => handleSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 border-2 border-doodle-text/30 rounded font-doodle text-sm focus:outline-none focus:border-doodle-accent bg-white"
                  />
                </div>
                <select
                  value={categoryFilter}
                  onChange={(e) => handleCategory(e.target.value)}
                  className="border-2 border-doodle-text/30 rounded px-2 py-1.5 font-doodle text-sm focus:outline-none focus:border-doodle-accent bg-white"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c === "all" ? "All categories" : c}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-2 ml-auto">
                  <span className="font-doodle text-sm text-doodle-text/60">
                    Show
                  </span>
                  {PAGE_SIZES.map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        setPageSize(n);
                        setPage(0);
                      }}
                      className={`px-2 py-1 border-2 rounded font-doodle text-sm ${pageSize === n ? "border-doodle-accent bg-doodle-accent/10 font-bold" : "border-doodle-text/30 hover:border-doodle-accent"}`}
                    >
                      {n}
                    </button>
                  ))}
                  <span className="font-doodle text-sm text-doodle-text/60">
                    of {filtered.length.toLocaleString()} products
                  </span>
                </div>
              </div>

              {/* ── Tab toggle ──────────────────────────────────────────── */}
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={() => setActiveTab("all")}
                  className={`doodle-button font-doodle text-sm flex items-center gap-1.5 ${activeTab === "all" ? "doodle-button-primary" : ""}`}
                >
                  <BarChart3 className="w-4 h-4" />
                  All Products
                  <span className="ml-1 text-xs opacity-60">
                    ({filtered.length})
                  </span>
                </button>
                <button
                  onClick={() => setActiveTab("opportunities")}
                  className={`doodle-button font-doodle text-sm flex items-center gap-1.5 ${activeTab === "opportunities" ? "doodle-button-primary" : ""}`}
                >
                  <Sparkles className="w-4 h-4" />
                  Sales Opportunities
                  {opportunities.length > 0 && (
                    <span className="ml-1 text-xs opacity-60">
                      ({opportunities.length})
                    </span>
                  )}
                </button>
              </div>

              {/* ── Opportunities callout ────────────────────────────────── */}
              {activeTab === "opportunities" && (
                <div className="doodle-card p-4 mb-4 flex items-start gap-3 bg-amber-50">
                  <Sparkles className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="font-doodle text-sm text-amber-800">
                    <strong>Sales Opportunities</strong> — products with high
                    margin and no active promotion, or with high stock but very
                    low sales velocity. Add a clearance promotion or adjust
                    pricing to unlock value.
                  </p>
                </div>
              )}

              {/* ── Table ────────────────────────────────────────────────── */}
              <div className="doodle-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b-2 border-doodle-text/20 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide w-10">
                        #
                      </th>
                      <SortTh
                        col="productName"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
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
                        col="profit"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        Profit
                      </SortTh>
                      <SortTh
                        col="marginPct"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        Margin %
                      </SortTh>
                      <SortTh
                        col="revenue"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        Revenue
                      </SortTh>
                      <SortTh
                        col="currentCost"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        Std Cost
                      </SortTh>
                      <SortTh
                        col="currentListPrice"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        List Price
                      </SortTh>
                      <SortTh
                        col="unitsSold"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        Units Sold
                      </SortTh>
                      <SortTh
                        col="currentStock"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Package className="w-3 h-3" />
                          Stock
                        </span>
                      </SortTh>
                      <SortTh
                        col="currentOrders"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        <span className="inline-flex items-center gap-1">
                          <ShoppingCart className="w-3 h-3" />
                          Orders
                        </span>
                      </SortTh>
                      <SortTh
                        col="activeDiscounts"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="text-right"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Tag className="w-3 h-3" />
                          Promos
                        </span>
                      </SortTh>
                      <th className="px-3 py-2 text-center font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide whitespace-nowrap min-w-[280px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-doodle-text/10">
                    {(activeTab === "all" ? pageRows : opportunities).map(
                      (row, i) => {
                        const globalRank =
                          activeTab === "all" ? page * pageSize + i + 1 : i + 1;
                        const tier = marginTier(row.marginPct, row.profit);
                        const isExpanded = expandedProductId === row.productID;
                        return (
                          <React.Fragment key={row.productID}>
                            <tr className={`${rowBg(tier)} transition-colors`}>
                              <td className="px-3 py-2 font-doodle text-xs text-doodle-text/50 tabular-nums">
                                {globalRank}
                              </td>
                              <td className="px-3 py-2">
                                <Link
                                  to={`/product/${row.productID}`}
                                  className="font-doodle text-sm font-medium text-doodle-text hover:text-doodle-accent hover:underline"
                                >
                                  {row.productName}
                                </Link>
                              </td>
                              <td className="px-3 py-2 font-doodle text-sm text-doodle-text/70 whitespace-nowrap">
                                {row.categoryName}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm font-bold tabular-nums">
                                <span
                                  className={
                                    row.profit < 0
                                      ? "text-red-600"
                                      : "text-doodle-text"
                                  }
                                >
                                  {fmt(row.profit)}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {marginBadge(row.marginPct, row.profit)}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums">
                                {fmt(row.revenue)}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums text-doodle-text/70">
                                {fmt(row.currentCost)}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums text-doodle-text/70">
                                {editingPrice?.productId === row.productID ? (
                                  <div className="flex items-center justify-end gap-1">
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
                                      className="w-20 px-1 py-0.5 border-2 border-doodle-accent focus:outline-none font-doodle text-xs text-right"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                          commitPriceEdit(row.productID);
                                        if (e.key === "Escape")
                                          cancelPriceEdit();
                                      }}
                                    />
                                    <button
                                      onClick={() =>
                                        commitPriceEdit(row.productID)
                                      }
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
                                      onClick={cancelPriceEdit}
                                      className="text-red-500 hover:text-red-600"
                                    >
                                      <XIcon className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => startPriceEdit(row)}
                                    className="flex items-center justify-end gap-1 w-full group"
                                    title="Edit list price"
                                  >
                                    {fmt(row.currentListPrice)}
                                    <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-50" />
                                  </button>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums">
                                {row.unitsSold.toLocaleString()}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums">
                                <span
                                  className={
                                    row.currentStock === 0
                                      ? "text-red-600 font-bold"
                                      : ""
                                  }
                                >
                                  {row.currentStock.toLocaleString()}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums">
                                {row.currentOrders > 0 ? (
                                  <Link
                                    to={`/orders?product=${row.productID}`}
                                    className="text-doodle-accent hover:underline font-bold"
                                  >
                                    {row.currentOrders}
                                  </Link>
                                ) : (
                                  <span className="text-doodle-text/50">0</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-doodle text-sm tabular-nums">
                                {row.activeDiscounts > 0 ? (
                                  <span className="inline-flex items-center gap-1 text-green-700 font-bold">
                                    <Tag className="w-3 h-3" />
                                    {row.activeDiscounts}
                                  </span>
                                ) : (
                                  <span className="text-doodle-text/40">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-center gap-1.5 flex-nowrap">
                                  <Link
                                    to={`/product/${row.productID}`}
                                    className="px-2 py-0.5 border border-doodle-text/30 rounded font-doodle text-xs hover:border-doodle-accent hover:text-doodle-accent whitespace-nowrap"
                                  >
                                    View
                                  </Link>
                                  {editingPrice?.productId !==
                                    row.productID && (
                                    <button
                                      onClick={() => startPriceEdit(row)}
                                      className="px-2 py-0.5 border border-doodle-text/30 rounded font-doodle text-xs hover:border-doodle-accent hover:text-doodle-accent whitespace-nowrap flex items-center gap-1"
                                      title="Edit list price"
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
                                    className="px-2 py-0.5 border border-doodle-text/30 rounded font-doodle text-xs hover:border-green-500 hover:text-green-700 whitespace-nowrap"
                                    title={`Add a promotion for ${row.productName}`}
                                  >
                                    + Promo
                                  </button>
                                  <button
                                    onClick={() =>
                                      setExpandedProductId(
                                        isExpanded ? null : row.productID,
                                      )
                                    }
                                    className="px-2 py-0.5 border border-doodle-text/30 rounded font-doodle text-xs hover:border-doodle-accent hover:text-doodle-accent whitespace-nowrap flex items-center gap-1"
                                    title="View sales trend"
                                  >
                                    <ChevronDown
                                      className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                    />
                                    Trend
                                  </button>
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-doodle-accent/5">
                                <td colSpan={13} className="px-6 py-3">
                                  <SalesTrendPanel productId={row.productID} channel={channel} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      },
                    )}
                    {(activeTab === "all" ? pageRows : opportunities).length ===
                      0 && (
                      <tr>
                        <td
                          colSpan={13}
                          className="px-3 py-8 text-center font-doodle text-sm text-doodle-text/50"
                        >
                          No products match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── Pagination ───────────────────────────────────────────── */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 font-doodle text-sm">
                  <span className="text-doodle-text/60">
                    Page {page + 1} of {totalPages} ·{" "}
                    {filtered.length.toLocaleString()} products
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                      className="p-1.5 border-2 border-doodle-text/30 rounded hover:border-doodle-accent disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      // show pages around current
                      let p: number;
                      if (totalPages <= 7) p = i;
                      else if (page < 4) p = i;
                      else if (page > totalPages - 5) p = totalPages - 7 + i;
                      else p = page - 3 + i;
                      return (
                        <button
                          key={p}
                          onClick={() => setPage(p)}
                          className={`px-2.5 py-1 border-2 rounded ${p === page ? "border-doodle-accent bg-doodle-accent/10 font-bold" : "border-doodle-text/30 hover:border-doodle-accent"}`}
                        >
                          {p + 1}
                        </button>
                      );
                    })}
                    <button
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage((p) => p + 1)}
                      className="p-1.5 border-2 border-doodle-text/30 rounded hover:border-doodle-accent disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>
      </main>
      <Footer />

      {/* ── Clearance promotion dialog ──────────────────────────────────── */}
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

export default ProductProfitabilityPage;
