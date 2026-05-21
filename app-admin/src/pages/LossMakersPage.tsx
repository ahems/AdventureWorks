import React, { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import {
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Tag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  Package,
  DollarSign,
  Percent,
  Check,
  X,
  Edit2,
  Ban,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import ChannelSelector from "@/components/ChannelSelector";
import { useAuth } from "@/context/AuthContext";
import {
  useProductProfitabilityDetailData,
  type ProductProfitDetail,
  type SalesChannel,
} from "@/hooks/useReportingData";
import {
  useUpdateProductPrice,
  useDiscontinueProduct,
} from "@/hooks/useAdminProducts";
import ClearancePromotionDialog, {
  type ClearanceProduct,
} from "@/components/ClearancePromotionDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
    className={`px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-red-50 ${className}`}
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

const PAGE_SIZES = [25, 50, 100] as const;

const LossMakersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [channel, setChannel] = useState<SalesChannel>("all");
  const {
    data: allData,
    isLoading,
    isError,
  } = useProductProfitabilityDetailData(channel);
  const { mutateAsync: updatePrice, isPending: isPriceSaving } =
    useUpdateProductPrice();
  const { mutateAsync: discontinue, isPending: isDiscontinuePending } =
    useDiscontinueProduct();

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortAsc, setSortAsc] = useState(true); // ascending = worst losses first
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0);

  // Inline price edit
  const [editingPrice, setEditingPrice] = useState<{
    productId: number;
    value: string;
  } | null>(null);

  // Discontinue confirm dialog
  const [discontinueTarget, setDiscontinueTarget] =
    useState<ProductProfitDetail | null>(null);

  // Clearance promotion dialog
  const [clearanceTarget, setClearanceTarget] =
    useState<ClearanceProduct | null>(null);
  const [clearanceDialogOpen, setClearanceDialogOpen] = useState(false);

  // ── derived data ────────────────────────────────────────────────────────────

  const lossData = useMemo(
    () => (allData ? allData.filter((r) => r.profit < 0) : []),
    [allData],
  );

  const filtered = useMemo(() => {
    let rows = lossData;
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
  }, [lossData, search, sortKey, sortAsc]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (col: SortKey) => {
    if (col === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(col);
      setSortAsc(true);
    }
    setPage(0);
  };

  const handleSearch = (v: string) => {
    setSearch(v);
    setPage(0);
  };

  // ── KPI aggregates ───────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    if (!lossData || lossData.length === 0) return null;
    const count = lossData.length;
    const totalLoss = lossData.reduce((s, r) => s + r.profit, 0);
    const avgMargin =
      lossData.reduce((s, r) => s + r.marginPct, 0) / lossData.length;
    const noPromoCount = lossData.filter((r) => r.activeDiscounts === 0).length;
    return { count, totalLoss, avgMargin, noPromoCount };
  }, [lossData]);

  // ── price edit handlers ──────────────────────────────────────────────────────

  const startEdit = (row: ProductProfitDetail) => {
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

  // ── discontinue handler ──────────────────────────────────────────────────────

  const confirmDiscontinue = async () => {
    if (!discontinueTarget) return;
    await discontinue({
      ProductID: discontinueTarget.productID,
      DiscontinuedDate: new Date().toISOString(),
    });
    setDiscontinueTarget(null);
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
                  <TrendingDown className="w-7 h-7 text-red-500" />
                  Loss Makers
                </h1>
                <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                  Products selling below cost. Review pricing, raise list price,
                  or discontinue to protect margin.
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <ChannelSelector channel={channel} onChange={setChannel} />
                <div className="flex gap-2 flex-wrap justify-end">
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
              These products have sold below their standard cost in all recorded
              orders. Inline price edits update the list price immediately. Use{" "}
              <strong>Discontinue</strong> to flag a product as end-of-life.
            </p>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <KpiCard
                  title="Loss-Making Products"
                  value={kpis.count}
                  subtitle="selling below cost"
                  icon={<TrendingDown className="w-5 h-5" />}
                  variant="danger"
                />
                <KpiCard
                  title="Total Accumulated Loss"
                  value={fmt(kpis.totalLoss)}
                  subtitle="across all-time orders"
                  icon={<DollarSign className="w-5 h-5" />}
                  variant="danger"
                />
                <KpiCard
                  title="Avg Negative Margin"
                  value={fmtPct(kpis.avgMargin)}
                  subtitle="average gross margin %"
                  icon={<Percent className="w-5 h-5" />}
                  variant="warn"
                />
                <KpiCard
                  title="No Active Promotion"
                  value={kpis.noPromoCount}
                  subtitle="of loss makers"
                  icon={<Tag className="w-5 h-5" />}
                  variant={kpis.noPromoCount > 5 ? "warn" : "default"}
                />
              </div>

              {/* ── Search & page-size ────────────────────────────────────── */}
              <div className="doodle-card p-4 mb-4 flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-48">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="Search products…"
                    className="w-full pl-9 pr-3 py-1.5 font-doodle text-sm border-2 border-doodle-text/30 bg-white focus:border-doodle-accent focus:outline-none"
                  />
                </div>
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
              <div className="doodle-card overflow-x-auto mb-4">
                <table className="w-full text-sm">
                  <thead className="bg-red-50/50 border-b-2 border-doodle-text/20">
                    <tr>
                      <SortTh
                        col="productName"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                        className="min-w-52"
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
                        col="profit"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                      >
                        Profit
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
                        col="unitsSold"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                      >
                        Units Sold
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
                        col="activeDiscounts"
                        current={sortKey}
                        asc={sortAsc}
                        onSort={handleSort}
                      >
                        Promos
                      </SortTh>
                      <th className="px-3 py-2 text-left font-doodle text-xs font-bold text-doodle-text/70 uppercase tracking-wide whitespace-nowrap min-w-[220px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          className="py-12 text-center font-doodle text-sm text-doodle-text/50"
                        >
                          {lossData.length === 0
                            ? "No loss-making products — great work!"
                            : "No results match your search."}
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((row) => {
                        const isEditing =
                          editingPrice?.productId === row.productID;
                        return (
                          <tr
                            key={row.productID}
                            className="border-b border-doodle-text/10 bg-red-50 hover:bg-red-100/60 transition-colors"
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
                                  <span className="text-doodle-text/50">$</span>
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
                                    title="Save"
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
                                    title="Cancel"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => startEdit(row)}
                                  className="flex items-center gap-1 text-doodle-text hover:text-doodle-accent group"
                                  title="Edit price"
                                >
                                  {fmt(row.currentListPrice)}
                                  <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-60" />
                                </button>
                              )}
                            </td>

                            <td className="px-3 py-2 font-doodle text-xs text-orange-700 font-semibold">
                              {fmt(row.currentCost)}
                            </td>
                            <td className="px-3 py-2 font-doodle text-xs font-bold text-red-600">
                              {fmt(row.profit)}
                            </td>
                            <td className="px-3 py-2 font-doodle text-xs font-bold text-red-600">
                              {fmtPct(row.marginPct)}
                            </td>
                            <td className="px-3 py-2 font-doodle text-xs text-doodle-text/70 text-right">
                              {row.unitsSold.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 font-doodle text-xs text-doodle-text/70 text-right">
                              {row.currentStock.toLocaleString()}
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
                                  className="doodle-button py-1 px-2 text-xs font-doodle flex items-center gap-1"
                                  title="Add clearance promotion"
                                >
                                  <Tag className="w-3 h-3" />
                                  Promo
                                </button>
                                <button
                                  onClick={() => setDiscontinueTarget(row)}
                                  className="doodle-button py-1 px-2 text-xs font-doodle flex items-center gap-1 text-red-600 border-red-300 hover:border-red-500"
                                  title="Discontinue product"
                                >
                                  <Ban className="w-3 h-3" />
                                  Retire
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
                <Package className="w-12 h-12 text-green-500 mx-auto mb-3" />
                <p className="font-doodle text-lg font-bold text-green-700">
                  No loss-making products found!
                </p>
                <p className="font-doodle text-sm text-doodle-text/60 mt-1">
                  All products are currently profitable.
                </p>
              </div>
            )
          )}
        </section>
      </main>
      <Footer />

      {/* ── Discontinue confirm dialog ──────────────────────────────────────── */}
      <AlertDialog
        open={!!discontinueTarget}
        onOpenChange={(open) => !open && setDiscontinueTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-doodle">
              <Ban className="w-5 h-5 text-red-500" />
              Discontinue Product
            </AlertDialogTitle>
            <AlertDialogDescription className="font-doodle">
              Are you sure you want to discontinue{" "}
              <strong>{discontinueTarget?.productName}</strong>? This sets the
              discontinued date to today. The product will remain in the
              database but is flagged as end-of-life.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isDiscontinuePending}
              className="font-doodle"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscontinue}
              disabled={isDiscontinuePending}
              className="font-doodle bg-red-600 hover:bg-red-700"
            >
              {isDiscontinuePending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Retiring…
                </>
              ) : (
                "Yes, Discontinue"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

export default LossMakersPage;
