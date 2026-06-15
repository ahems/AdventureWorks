import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ShoppingCart,
  Globe,
  Building2,
  Package,
  AlertTriangle,
  Calendar as CalendarIcon,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  Filter,
  CalendarPlus,
} from "lucide-react";
import {
  fetchAllProducts,
  fetchProductInventory,
  fetchWorkOrders,
  fetchProductSubcategories,
} from "@/services/api";
import {
  loadOpenDemand,
  loadHistoricalDemand,
  fetchLatestShippedOrderDate,
} from "@/services/salesApi";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import ScheduleProductionDialog from "@/components/ScheduleProductionDialog";
import { SALES_ORDER_STATUS, type Product } from "@/types/production";

const fmtDate = (s: string) => new Date(s).toLocaleDateString();

const KpiTile = ({
  icon: Icon,
  label,
  value,
  sub,
  color = "text-doodle-text",
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  sub?: string;
  color?: string;
}) => (
  <div className="doodle-card-static p-4">
    <div className="flex items-center gap-2 font-doodle text-xs text-muted-foreground">
      <Icon className={`w-3.5 h-3.5 ${color}`} /> {label}
    </div>
    <div className={`font-doodle text-2xl font-bold mt-1 ${color}`}>
      {value}
    </div>
    {sub && (
      <div className="font-doodle text-[11px] text-muted-foreground mt-0.5">
        {sub}
      </div>
    )}
  </div>
);

const PlanDemand = () => {
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [channelFilter, setChannelFilter] = useState<"all" | "eshop" | "b2b">(
    "all",
  );
  const [mfgOnly, setMfgOnly] = useState(true);
  const [subcategoryFilter, setSubcategoryFilter] = useState<string>("all");
  // Auto-open scheduling dialog driven by row click. Holds the productId of the
  // currently-selected row; the dialog reads its prefill from the row's row map.
  const [scheduleProductId, setScheduleProductId] = useState<number | null>(
    null,
  );
  const [scheduleSource, setScheduleSource] = useState<
    "open-demand" | "history-30d"
  >("open-demand");

  const { data: openData, isLoading: openLoading } = useQuery({
    queryKey: ["open-demand"],
    queryFn: loadOpenDemand,
    refetchInterval: 30_000,
  });

  const { data: anchorISO } = useQuery({
    queryKey: ["demand-anchor-date"],
    queryFn: fetchLatestShippedOrderDate,
    staleTime: 5 * 60_000,
  });

  // Use latest shipped-order date as "now" so trailing windows aren't empty against the static dataset.
  const anchorDate = useMemo(
    () => (anchorISO ? new Date(anchorISO) : new Date()),
    [anchorISO],
  );

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ["historical-demand", anchorISO],
    queryFn: () => loadHistoricalDemand(anchorDate),
    staleTime: 5 * 60_000,
    enabled: !!anchorISO,
  });

  const { data: products } = useQuery({
    queryKey: ["all-products"],
    queryFn: fetchAllProducts,
  });
  const { data: inventory } = useQuery({
    queryKey: ["inventory-all"],
    queryFn: () => fetchProductInventory(),
  });
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
  });
  const { data: subcategories } = useQuery({
    queryKey: ["product-subcategories"],
    queryFn: fetchProductSubcategories,
  });

  const subcategoryMap = useMemo(() => {
    const m = new Map<number, string>();
    subcategories?.forEach((s) => m.set(s.ProductSubcategoryID, s.Name));
    return m;
  }, [subcategories]);

  const productMap = useMemo(() => {
    const m = new Map<
      number,
      {
        name: string;
        daysToManufacture: number;
        safetyStock: number;
        reorderPoint: number;
        subcategory: string;
        raw: Product;
      }
    >();
    products?.forEach((p) =>
      m.set(p.ProductID, {
        name: p.Name,
        daysToManufacture: p.DaysToManufacture,
        safetyStock: p.SafetyStockLevel,
        reorderPoint: p.ReorderPoint,
        subcategory: p.ProductSubcategoryID
          ? (subcategoryMap.get(p.ProductSubcategoryID) ?? "—")
          : "—",
        raw: p,
      }),
    );
    return m;
  }, [products, subcategoryMap]);

  const onHandByProduct = useMemo(() => {
    const m = new Map<number, number>();
    inventory?.forEach((i) =>
      m.set(i.ProductID, (m.get(i.ProductID) || 0) + i.Quantity),
    );
    return m;
  }, [inventory]);

  const openWipByProduct = useMemo(() => {
    const m = new Map<number, number>();
    workOrders?.forEach((wo) => {
      const remaining = wo.OrderQty - wo.StockedQty;
      if (remaining > 0)
        m.set(wo.ProductID, (m.get(wo.ProductID) || 0) + remaining);
    });
    return m;
  }, [workOrders]);

  const openRows = openData?.rows ?? [];
  const totalOpenUnits = openRows.reduce((s, r) => s + r.openQty, 0);
  const totalOpenOrders = openData?.headers.length ?? 0;
  const earliestDue = useMemo(() => {
    if (!openData?.headers.length) return null;
    return openData.headers.reduce(
      (min, h) => (new Date(h.DueDate) < new Date(min) ? h.DueDate : min),
      openData.headers[0].DueDate,
    );
  }, [openData]);
  const openEshop = openRows.reduce((s, r) => s + r.eShopQty, 0);
  const openB2b = openRows.reduce((s, r) => s + r.b2bQty, 0);

  // Historical KPIs
  const histTotals = useMemo(() => {
    const rows = histData ?? [];
    const tot30 = rows.reduce((s, r) => s + r.qty30d, 0);
    const tot90 = rows.reduce((s, r) => s + r.qty90d, 0);
    const tot365 = rows.reduce((s, r) => s + r.qty365d, 0);
    const eshop = rows.reduce((s, r) => s + r.eShopQty, 0);
    const b2b = rows.reduce((s, r) => s + r.b2bQty, 0);
    return { tot30, tot90, tot365, products: rows.length, eshop, b2b };
  }, [histData]);

  const subcategoryOptions = useMemo(() => {
    const set = new Set<string>();
    (histData ?? []).forEach((r) => {
      const s = productMap.get(r.productId)?.subcategory;
      if (s && s !== "—") set.add(s);
    });
    return [...set].sort();
  }, [histData, productMap]);

  const histRowsSorted = useMemo(() => {
    let rows = (histData ?? []).slice();
    if (mfgOnly)
      rows = rows.filter((r) => productMap.get(r.productId)?.raw?.MakeFlag);
    if (subcategoryFilter !== "all")
      rows = rows.filter(
        (r) => productMap.get(r.productId)?.subcategory === subcategoryFilter,
      );
    if (channelFilter === "eshop") rows = rows.filter((r) => r.eShopQty > 0);
    if (channelFilter === "b2b") rows = rows.filter((r) => r.b2bQty > 0);
    rows.sort((a, b) => b.qty90d - a.qty90d);
    return showAll ? rows : rows.slice(0, 25);
  }, [
    histData,
    showAll,
    mfgOnly,
    subcategoryFilter,
    channelFilter,
    productMap,
  ]);

  const coverageDays = (productId: number, qty30: number) => {
    const stock = onHandByProduct.get(productId) || 0;
    const wip = openWipByProduct.get(productId) || 0;
    const daily = qty30 / 30;
    if (daily <= 0) return null;
    return Math.min(365, Math.round((stock + wip) / daily));
  };

  /**
   * Visual coverage breakdown: stacked bar showing On-hand + WIP vs total demand,
   * with the shortfall portion highlighted in accent. Recomputes whenever the
   * caller passes new stock / wip / demand values, so filters update it live.
   */
  const CoverageBreakdown = ({
    stock,
    wip,
    demand,
  }: {
    stock: number;
    wip: number;
    demand: number;
  }) => {
    const covered = Math.min(stock + wip, demand);
    const shortfall = Math.max(0, demand - stock - wip);
    const denom = Math.max(demand, stock + wip, 1);
    const stockPct = (Math.min(stock, demand) / denom) * 100;
    const wipPct = (Math.min(wip, Math.max(0, demand - stock)) / denom) * 100;
    const shortPct = (shortfall / denom) * 100;
    return (
      <div className="min-w-[140px]">
        <div className="flex h-2 w-full overflow-hidden rounded border border-doodle-text/20 bg-secondary/40">
          {stockPct > 0 && (
            <div
              style={{ width: `${stockPct}%` }}
              className="bg-doodle-green"
              title={`On-hand ${stock}`}
            />
          )}
          {wipPct > 0 && (
            <div
              style={{ width: `${wipPct}%` }}
              className="bg-doodle-blue"
              title={`WIP ${wip}`}
            />
          )}
          {shortPct > 0 && (
            <div
              style={{ width: `${shortPct}%` }}
              className="bg-doodle-accent"
              title={`Short ${shortfall}`}
            />
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 font-doodle text-[10px]">
          <span className="text-doodle-green">On {stock}</span>
          <span className="text-doodle-blue">WIP {wip}</span>
          {shortfall > 0 ? (
            <span className="text-doodle-accent font-bold">
              Short {shortfall}
            </span>
          ) : (
            <span className="text-doodle-green">Covered</span>
          )}
        </div>
      </div>
    );
  };

  /**
   * Source badge so users can see at a glance where the suggested schedule
   * quantity will come from before they open the dialog.
   */
  const SourceBadge = ({
    source,
  }: {
    source: "open-demand" | "history-30d" | "reorder-point";
  }) => {
    const map = {
      "open-demand": {
        label: "Open demand",
        cls: "bg-doodle-accent/15 text-doodle-accent border-doodle-accent",
      },
      "history-30d": {
        label: "30-day history",
        cls: "bg-doodle-blue/15 text-doodle-blue border-doodle-blue",
      },
      "reorder-point": {
        label: "Reorder point",
        cls: "bg-doodle-green/15 text-doodle-green border-doodle-green",
      },
    } as const;
    const { label, cls } = map[source];
    return (
      <span
        className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-doodle border rounded ${cls}`}
        title={`Suggested qty derived from ${label.toLowerCase()}`}
      >
        {label}
      </span>
    );
  };

  const coverageBadge = (days: number | null) => {
    if (days === null)
      return <span className="text-xs text-muted-foreground">—</span>;
    let cls = "bg-doodle-green/20 text-doodle-green border-doodle-green";
    let label = `${days}d`;
    if (days < 14)
      cls = "bg-doodle-accent/20 text-doodle-accent border-doodle-accent";
    else if (days < 30) cls = "bg-amber-500/20 text-amber-700 border-amber-500";
    if (days >= 365) label = "365d+";
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 text-xs border rounded ${cls}`}
      >
        {label}
      </span>
    );
  };

  return (
    <div className="container mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="font-doodle text-2xl font-bold text-doodle-text">
          3. Plan — Customer Demand
        </h1>
        <p className="font-doodle text-sm text-muted-foreground">
          Sales orders flowing in from the eShop and B2B store portal. Use this
          to prioritize which products to schedule next.
        </p>
      </div>

      {/* OPEN DEMAND */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-doodle-accent" /> Open Demand
            <span className="font-normal text-xs text-muted-foreground">
              live · refreshes every 30s
            </span>
          </h2>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            icon={ShoppingCart}
            label="Open Orders"
            value={totalOpenOrders}
            color="text-doodle-accent"
          />
          <KpiTile
            icon={Package}
            label="Open Units"
            value={totalOpenUnits}
            color="text-doodle-blue"
          />
          <KpiTile
            icon={CalendarIcon}
            label="Earliest Due"
            value={earliestDue ? fmtDate(earliestDue) : "—"}
          />
          <KpiTile
            icon={Globe}
            label="Channel Split"
            value={
              <span className="text-base">
                <span className="text-doodle-blue">{openEshop}</span>
                <span className="text-muted-foreground text-sm"> eShop · </span>
                <span className="text-doodle-green">{openB2b}</span>
                <span className="text-muted-foreground text-sm"> B2B</span>
              </span>
            }
          />
        </div>

        {openLoading ? (
          <TableSkeleton rows={3} cols={7} />
        ) : openRows.length === 0 ? (
          <div className="doodle-card-static p-6 text-center font-doodle">
            <p className="text-doodle-text font-bold">
              No open customer orders right now
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              When the eShop or B2B portal accepts a new order it will appear
              here within 30 seconds.
            </p>
          </div>
        ) : (
          <div className="doodle-card-static overflow-x-auto">
            <table className="w-full font-doodle text-sm">
              <thead>
                <tr className="border-b-2 border-doodle-text/20">
                  <th className="text-left py-3 px-4 w-8"></th>
                  <th className="text-left py-3 px-4">Product</th>
                  <th className="text-right py-3 px-4">Open Qty</th>
                  <th className="text-left py-3 px-4">Earliest Due</th>
                  <th className="text-left py-3 px-4">Channel</th>
                  <th className="text-left py-3 px-4 min-w-[160px]">
                    Coverage breakdown
                  </th>
                  <th className="text-right py-3 px-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {openRows.map((row) => {
                  const p = productMap.get(row.productId);
                  const stock = onHandByProduct.get(row.productId) || 0;
                  const wip = openWipByProduct.get(row.productId) || 0;
                  const shortfall = row.openQty - stock - wip;
                  const isOpen = expandedProduct === row.productId;
                  return (
                    <Fragment key={row.productId}>
                      <tr
                        key={row.productId}
                        className={`border-b border-doodle-text/10 hover:bg-secondary/30 ${p?.raw && shortfall > 0 ? "cursor-pointer" : ""}`}
                        onClick={() => {
                          if (p?.raw && shortfall > 0) {
                            setScheduleSource("open-demand");
                            setScheduleProductId(row.productId);
                          }
                        }}
                        title={
                          p?.raw && shortfall > 0
                            ? "Click to schedule production for this shortfall"
                            : undefined
                        }
                      >
                        <td
                          className="px-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() =>
                              setExpandedProduct(isOpen ? null : row.productId)
                            }
                            aria-label="Show orders"
                          >
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            )}
                          </button>
                        </td>
                        <td
                          className="py-2.5 px-4"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Link
                            to={`/define/products/${row.productId}`}
                            className="text-doodle-blue hover:underline font-bold"
                          >
                            {p?.name ?? `#${row.productId}`}
                          </Link>
                        </td>
                        <td className="text-right py-2.5 px-4 font-bold">
                          {row.openQty}
                        </td>
                        <td className="py-2.5 px-4">
                          {fmtDate(row.earliestDueDate)}
                        </td>
                        <td className="py-2.5 px-4 text-xs">
                          {row.eShopQty > 0 && (
                            <span className="inline-flex items-center gap-1 mr-2">
                              <Globe className="w-3 h-3" /> eShop:{" "}
                              {row.eShopQty}
                            </span>
                          )}
                          {row.b2bQty > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <Building2 className="w-3 h-3" /> B2B:{" "}
                              {row.b2bQty}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4">
                          <CoverageBreakdown
                            stock={stock}
                            wip={wip}
                            demand={row.openQty}
                          />
                        </td>
                        <td className="text-right py-2.5 px-4">
                          {p?.raw && shortfall > 0 ? (
                            <div className="inline-flex flex-col items-end gap-1">
                              <SourceBadge source="open-demand" />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setScheduleSource("open-demand");
                                  setScheduleProductId(row.productId);
                                }}
                                className="doodle-button doodle-button-primary text-xs inline-flex items-center gap-1 py-1 px-2"
                              >
                                <CalendarPlus className="w-3.5 h-3.5" />{" "}
                                Schedule
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-secondary/20 border-b border-doodle-text/10">
                          <td colSpan={7} className="px-6 py-3">
                            <div className="font-doodle text-xs text-muted-foreground mb-2">
                              Underlying customer orders:
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="py-1 pr-3">Order #</th>
                                  <th className="py-1 pr-3">Channel</th>
                                  <th className="py-1 pr-3">Status</th>
                                  <th className="py-1 pr-3">Customer</th>
                                  <th className="py-1 pr-3">Due</th>
                                  <th className="py-1 pr-3 text-right">Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.orderRefs.map((o) => (
                                  <tr
                                    key={`${o.salesOrderId}-${o.qty}`}
                                    className="border-t border-doodle-text/10"
                                  >
                                    <td className="py-1 pr-3 font-mono">
                                      {o.salesOrderNumber}
                                    </td>
                                    <td className="py-1 pr-3">
                                      {o.online ? "eShop" : "B2B"}
                                    </td>
                                    <td className="py-1 pr-3">
                                      {SALES_ORDER_STATUS[o.status] ?? o.status}
                                    </td>
                                    <td className="py-1 pr-3">
                                      #{o.customerId}
                                    </td>
                                    <td className="py-1 pr-3">
                                      {fmtDate(o.dueDate)}
                                    </td>
                                    <td className="py-1 pr-3 text-right font-bold">
                                      {o.qty}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* HISTORICAL DEMAND */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-doodle-blue" /> Historical
            Demand
          </h2>
          <span className="font-doodle text-xs text-muted-foreground">
            Trailing windows anchored to the latest shipped-order date{" "}
            {anchorISO ? `(${fmtDate(anchorISO)})` : ""}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            icon={Package}
            label="Units (30d)"
            value={histTotals.tot30}
            color="text-doodle-accent"
          />
          <KpiTile
            icon={Package}
            label="Units (90d)"
            value={histTotals.tot90}
            color="text-doodle-blue"
          />
          <KpiTile
            icon={Package}
            label="Units (365d)"
            value={histTotals.tot365}
          />
          <KpiTile
            icon={Globe}
            label="Channel (90d)"
            value={
              <span className="text-base">
                <span className="text-doodle-blue">{histTotals.eshop}</span>
                <span className="text-muted-foreground text-sm"> eShop · </span>
                <span className="text-doodle-green">{histTotals.b2b}</span>
                <span className="text-muted-foreground text-sm"> B2B</span>
              </span>
            }
            sub={`${histTotals.products} products`}
          />
        </div>

        {/* Filter bar */}
        <div className="doodle-card-static p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 font-doodle text-xs text-muted-foreground">
            <Filter className="w-3.5 h-3.5" /> Filters
          </div>
          <label className="flex items-center gap-1.5 font-doodle text-xs">
            Channel
            <select
              value={channelFilter}
              onChange={(e) =>
                setChannelFilter(e.target.value as "all" | "eshop" | "b2b")
              }
              className="doodle-input text-xs py-1"
            >
              <option value="all">All</option>
              <option value="eshop">eShop only</option>
              <option value="b2b">B2B only</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 font-doodle text-xs">
            Subcategory
            <select
              value={subcategoryFilter}
              onChange={(e) => setSubcategoryFilter(e.target.value)}
              className="doodle-input text-xs py-1"
            >
              <option value="all">All</option>
              {subcategoryOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 font-doodle text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={mfgOnly}
              onChange={(e) => setMfgOnly(e.target.checked)}
            />
            Manufactured products only
          </label>
          <span className="ml-auto font-doodle text-xs text-muted-foreground">
            {histRowsSorted.length} of {histData?.length ?? 0}
          </span>
        </div>

        {histLoading ? (
          <TableSkeleton rows={8} cols={8} />
        ) : (
          <div className="doodle-card-static overflow-x-auto">
            <table className="w-full font-doodle text-sm">
              <thead>
                <tr className="border-b-2 border-doodle-text/20">
                  <th className="text-left py-3 px-4">Product</th>
                  <th className="text-left py-3 px-4">Subcategory</th>
                  <th className="text-right py-3 px-4">Qty 30d</th>
                  <th className="text-right py-3 px-4">Qty 90d</th>
                  <th className="text-right py-3 px-4">Qty 365d</th>
                  <th className="text-left py-3 px-4 min-w-[160px]">
                    Coverage breakdown
                  </th>
                  <th className="text-center py-3 px-4">Days</th>
                  <th className="text-right py-3 px-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {histRowsSorted.map((row) => {
                  const p = productMap.get(row.productId);
                  const stock = onHandByProduct.get(row.productId) || 0;
                  const wip = openWipByProduct.get(row.productId) || 0;
                  const cov = coverageDays(row.productId, row.qty30d);
                  const isMfg = !!p?.raw?.MakeFlag;
                  // Demand shortfall: project 30-day demand against on-hand + WIP.
                  const histShortfall = Math.max(0, row.qty30d - stock - wip);
                  const canSchedule = isMfg && !!p?.raw && histShortfall > 0;
                  return (
                    <tr
                      key={row.productId}
                      className={`border-b border-doodle-text/10 hover:bg-secondary/30 ${canSchedule ? "cursor-pointer" : ""}`}
                      onClick={() => {
                        if (canSchedule) {
                          setScheduleSource("history-30d");
                          setScheduleProductId(row.productId);
                        }
                      }}
                      title={
                        canSchedule
                          ? "Click to schedule production for this shortfall"
                          : undefined
                      }
                    >
                      <td
                        className="py-2.5 px-4"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Link
                          to={`/define/products/${row.productId}`}
                          className="text-doodle-blue hover:underline font-bold"
                        >
                          {p?.name ?? `#${row.productId}`}
                        </Link>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-muted-foreground">
                        {p?.subcategory ?? "—"}
                      </td>
                      <td className="text-right py-2.5 px-4">{row.qty30d}</td>
                      <td className="text-right py-2.5 px-4 font-bold">
                        {row.qty90d}
                      </td>
                      <td className="text-right py-2.5 px-4 text-muted-foreground">
                        {row.qty365d}
                      </td>
                      <td className="py-2.5 px-4">
                        <CoverageBreakdown
                          stock={stock}
                          wip={wip}
                          demand={row.qty30d}
                        />
                      </td>
                      <td className="text-center py-2.5 px-4">
                        {coverageBadge(cov)}
                      </td>
                      <td className="text-right py-2.5 px-4">
                        {canSchedule ? (
                          <div className="inline-flex flex-col items-end gap-1">
                            <SourceBadge source="history-30d" />
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setScheduleSource("history-30d");
                                setScheduleProductId(row.productId);
                              }}
                              className="doodle-button doodle-button-primary text-xs inline-flex items-center gap-1 py-1 px-2"
                            >
                              <CalendarPlus className="w-3.5 h-3.5" /> Schedule
                            </button>
                          </div>
                        ) : !isMfg ? (
                          <span className="text-xs text-muted-foreground">
                            purchased
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            covered
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(histData?.length ?? 0) > 25 && (
              <div className="p-3 text-center border-t border-doodle-text/10">
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="font-doodle text-xs text-doodle-blue hover:underline"
                >
                  {showAll
                    ? "Show top 25 only"
                    : `Show all ${histData!.length} products`}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Single controlled scheduling dialog — opens when a shortfall row is clicked. */}
      {(() => {
        if (scheduleProductId === null) return null;
        const p = productMap.get(scheduleProductId);
        if (!p?.raw) return null;
        const stock = onHandByProduct.get(scheduleProductId) || 0;
        const wip = openWipByProduct.get(scheduleProductId) || 0;
        if (scheduleSource === "open-demand") {
          const row = openRows.find((r) => r.productId === scheduleProductId);
          if (!row) return null;
          const shortfall = Math.max(1, row.openQty - stock - wip);
          const lead = p.daysToManufacture || 0;
          const due = new Date(
            new Date(row.earliestDueDate).getTime() - lead * 86400000,
          )
            .toISOString()
            .split("T")[0];
          return (
            <ScheduleProductionDialog
              product={p.raw}
              currentQty={stock}
              suggestedQty={shortfall}
              suggestedDueDate={due}
              suggestionLabel={`covers ${shortfall} unit shortfall vs ${row.openOrders} open order${row.openOrders === 1 ? "" : "s"}`}
              suggestionSource="open-demand"
              suggestionFormula={`Open shortfall = max(1, OpenQty − OnHand − WIP)\n= max(1, ${row.openQty} − ${stock} − ${wip}) = ${shortfall}`}
              open
              onOpenChange={(v) => !v && setScheduleProductId(null)}
              hideTrigger
            />
          );
        }
        const hRow = (histData ?? []).find(
          (r) => r.productId === scheduleProductId,
        );
        if (!hRow) return null;
        const histShortfall = Math.max(1, hRow.qty30d - stock - wip);
        return (
          <ScheduleProductionDialog
            product={p.raw}
            currentQty={stock}
            suggestedQty={histShortfall}
            suggestionLabel={`covers ${histShortfall} unit shortfall vs 30-day demand`}
            suggestionSource="history-30d"
            suggestionFormula={`30-day shortfall = max(1, Qty30d − OnHand − WIP)\n= max(1, ${hRow.qty30d} − ${stock} − ${wip}) = ${histShortfall}`}
            open
            onOpenChange={(v) => !v && setScheduleProductId(null)}
            hideTrigger
          />
        );
      })()}
    </div>
  );
};

export default PlanDemand;
