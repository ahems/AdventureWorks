import React from "react";
import { Navigate, Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  Legend,
} from "recharts";
import { BarChart3, Loader2, AlertCircle } from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useRevenueByCategoryData,
  useMonthlyRevenueTrendData,
  useTopProductsData,
  useOrdersByStatusData,
  useRevenueByTerritoryData,
  useInventoryByCategoryData,
} from "@/hooks/useReportingData";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COLORS = [
  "hsl(var(--doodle-accent))",
  "hsl(var(--doodle-green))",
  "hsl(var(--doodle-blue))",
  "hsl(var(--doodle-yellow))",
  "#8884d8",
  "#82ca9d",
  "#ffc658",
  "#ff7c43",
];

const ORDER_STATUS_LABELS: Record<number, string> = {
  1: "In Process",
  2: "Approved",
  3: "Backordered",
  4: "Rejected",
  5: "Shipped",
  6: "Cancelled",
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const fmt = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(0)}K`
      : `$${n.toLocaleString()}`;

// ─── Shared sub-components ───────────────────────────────────────────────────

const ChartCard: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="doodle-card p-6">
    <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4 flex items-center gap-2">
      <BarChart3 className="w-5 h-5 text-doodle-accent" />
      {title}
    </h2>
    {children}
  </div>
);

const ChartLoading: React.FC = () => (
  <div className="h-64 flex items-center justify-center">
    <Loader2 className="w-6 h-6 animate-spin text-doodle-accent" />
    <span className="ml-2 font-doodle text-sm text-doodle-text/60">
      Loading…
    </span>
  </div>
);

const ChartError: React.FC<{ message?: string }> = ({ message }) => (
  <div className="h-64 flex items-center justify-center gap-2 text-red-500">
    <AlertCircle className="w-5 h-5" />
    <span className="font-doodle text-sm">
      {message ?? "Failed to load data"}
    </span>
  </div>
);

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ value: unknown; name?: string }>;
  label?: string;
}

const CurrencyTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border-2 border-doodle-text p-2 shadow-lg">
      <p className="font-doodle text-sm font-bold text-doodle-text">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="font-doodle text-sm text-doodle-accent">
          {typeof p.value === "number" ? fmt(p.value) : String(p.value)}
        </p>
      ))}
    </div>
  );
};

// ─── Individual chart sections ───────────────────────────────────────────────

const RevenueByCategoryChart: React.FC = () => {
  const { data, isLoading, isError } = useRevenueByCategoryData();
  return (
    <ChartCard title="Revenue by Product Category">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                dataKey="categoryName"
                tick={{ fontFamily: "inherit", fontSize: 12 }}
              />
              <YAxis
                tickFormatter={(v) => fmt(v)}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <Tooltip content={<CurrencyTooltip />} />
              <Bar dataKey="revenue" fill={COLORS[0]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
};

const MonthlyTrendChart: React.FC = () => {
  const { data, isLoading, isError } = useMonthlyRevenueTrendData();
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((d) => ({
        ...d,
        label: `${MONTH_NAMES[d.month - 1]} ${d.year}`,
      })),
    [data],
  );
  return (
    <ChartCard title="Monthly Revenue Trend (Last 12 Months)">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
            >
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS[0]} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={COLORS[0]} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                dataKey="label"
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(v) => fmt(v)}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <Tooltip content={<CurrencyTooltip />} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke={COLORS[0]}
                fill="url(#revGrad)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
};

const TopProductsChart: React.FC = () => {
  const { data, isLoading, isError } = useTopProductsData(10);
  return (
    <ChartCard title="Top 10 Products by Revenue">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 60, bottom: 5, left: 140 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                type="number"
                tickFormatter={(v) => fmt(v)}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="productName"
                width={130}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <Tooltip content={<CurrencyTooltip />} />
              <Bar dataKey="revenue" fill={COLORS[1]} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
};

const OrdersByStatusChart: React.FC = () => {
  const { data, isLoading, isError } = useOrdersByStatusData();
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((d) => ({
        name: ORDER_STATUS_LABELS[d.status] ?? `Status ${d.status}`,
        value: d.orderCount,
      })),
    [data],
  );
  const total = chartData.reduce((s, d) => s + d.value, 0);
  return (
    <ChartCard title="Orders by Status">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-64 flex items-center gap-4">
          <ResponsiveContainer width="55%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="40%"
                outerRadius="75%"
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: unknown) =>
                  typeof v === "number"
                    ? [
                        `${v.toLocaleString()} (${((v / total) * 100).toFixed(1)}%)`,
                        "Orders",
                      ]
                    : [v, "Orders"]
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-1.5 text-sm flex-1">
            {chartData.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
                <span className="font-doodle text-doodle-text/80 truncate">
                  {d.name}
                </span>
                <span className="font-doodle text-doodle-text font-bold ml-auto">
                  {d.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ChartCard>
  );
};

const RevenueByTerritoryChart: React.FC = () => {
  const { data, isLoading, isError } = useRevenueByTerritoryData();
  return (
    <ChartCard title="Revenue by Sales Territory">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 60, bottom: 5, left: 110 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                type="number"
                tickFormatter={(v) => fmt(v)}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="territoryName"
                width={100}
                tick={{ fontFamily: "inherit", fontSize: 11 }}
              />
              <Tooltip content={<CurrencyTooltip />} />
              <Bar dataKey="revenue" fill={COLORS[2]} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
};

const InventoryByCategoryChart: React.FC = () => {
  const { data, isLoading, isError } = useInventoryByCategoryData();
  return (
    <ChartCard title="Inventory Units by Product Category">
      {isLoading ? (
        <ChartLoading />
      ) : isError || !data ? (
        <ChartError />
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 5, right: 20, bottom: 5, left: 20 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                dataKey="categoryName"
                tick={{ fontFamily: "inherit", fontSize: 12 }}
              />
              <YAxis tick={{ fontFamily: "inherit", fontSize: 11 }} />
              <Tooltip
                formatter={(v: unknown, name: string) => [
                  typeof v === "number" ? v.toLocaleString() : v,
                  name === "totalQuantity" ? "Units in Stock" : name,
                ]}
              />
              <Bar
                dataKey="totalQuantity"
                name="Units in Stock"
                fill={COLORS[3]}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const ReportsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-6 mb-6">
            <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
              <BarChart3 className="w-7 h-7 text-doodle-accent" />
              Reports
            </h1>
            <p className="font-doodle text-sm text-doodle-text/60 mt-1">
              Pre-aggregated reports across the full AdventureWorks dataset.
            </p>
            <Link
              to="/customer-stats"
              className="doodle-button mt-3 inline-flex items-center gap-2 font-doodle text-sm"
            >
              Customer Statistics →
            </Link>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RevenueByCategoryChart />
            <MonthlyTrendChart />
            <TopProductsChart />
            <OrdersByStatusChart />
            <RevenueByTerritoryChart />
            <InventoryByCategoryChart />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ReportsPage;
