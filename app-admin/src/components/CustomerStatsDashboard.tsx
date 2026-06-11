import React, { useMemo } from "react";
import { Users, DollarSign, TrendingUp, Globe } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  Line,
} from "recharts";
import type {
  CustomerStatsSummary,
  CustomerCountryStat,
  CustomerRegionStat,
  CustomerMonthlyRevenue,
} from "@/types/customerStats";

interface CustomerStatsDashboardProps {
  summary?: CustomerStatsSummary;
  countryStats: CustomerCountryStat[];
  regionStats: CustomerRegionStat[];
  monthlyRevenue: CustomerMonthlyRevenue[];
}

const CHART_COLORS = [
  "hsl(15, 80%, 55%)",
  "hsl(145, 45%, 35%)",
  "hsl(217, 100%, 67%)",
  "hsl(32, 50%, 70%)",
  "hsl(0, 72%, 51%)",
  "hsl(280, 60%, 50%)",
  "hsl(45, 90%, 50%)",
  "hsl(180, 50%, 45%)",
  "hsl(330, 70%, 55%)",
  "hsl(200, 60%, 50%)",
];

const REGION_COLORS: Record<string, string> = {
  "North America": "hsl(217, 100%, 67%)",
  Europe:          "hsl(145, 45%, 35%)",
  Pacific:         "hsl(15, 80%, 55%)",
};

const tooltipStyle = {
  fontFamily: "Short Stack",
  border: "2px solid #3c3c3c",
  borderRadius: "4px",
};

const CustomerStatsDashboard: React.FC<CustomerStatsDashboardProps> = ({
  summary,
  countryStats,
  regionStats,
  monthlyRevenue,
}) => {
  const topCountriesByRevenue = useMemo(
    () =>
      countryStats
        .slice(0, 10)
        .map((c) => ({ country: c.countryName, revenue: c.totalRevenue })),
    [countryStats],
  );

  const topCountriesByCustomers = useMemo(
    () =>
      countryStats
        .slice(0, 10)
        .map((c) => ({ country: c.countryName, value: c.customerCount })),
    [countryStats],
  );

  const regionDonutData = useMemo(
    () => regionStats.map((r) => ({ name: r.regionGroup, value: r.totalRevenue })),
    [regionStats],
  );

  const spendingBuckets = useMemo(
    () => (summary?.spendingBuckets ?? []).map((b) => ({ name: b.bucket, value: b.count })),
    [summary],
  );

  return (
    <section className="container mx-auto px-4 pb-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-doodle-accent/20 flex items-center justify-center rounded">
              <Users className="w-5 h-5 text-doodle-accent" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Total Customers</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">
                {summary ? summary.totalCustomers.toLocaleString() : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-doodle-green/20 flex items-center justify-center rounded">
              <DollarSign className="w-5 h-5 text-doodle-green" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Total Revenue</p>
              <p className="font-doodle text-2xl font-bold text-doodle-green">
                {summary
                  ? `$${summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                  : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-doodle-blue/20 flex items-center justify-center rounded">
              <TrendingUp className="w-5 h-5 text-doodle-blue" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Avg. Spending</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">
                {summary
                  ? `$${summary.avgRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                  : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-500/20 flex items-center justify-center rounded">
              <Globe className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Countries Served</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">
                {summary ? summary.countriesServed : "—"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Country */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">
            Revenue by Country (Top 10)
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={topCountriesByRevenue}
                layout="vertical"
                margin={{ left: 10, right: 20 }}
              >
                <XAxis
                  type="number"
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                  tick={{ fontFamily: "Short Stack", fontSize: 12 }}
                />
                <YAxis
                  type="category"
                  dataKey="country"
                  width={100}
                  tick={{ fontFamily: "Short Stack", fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value: number) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
                    "Revenue",
                  ]}
                  contentStyle={tooltipStyle}
                />
                <Bar dataKey="revenue" fill="hsl(15, 80%, 55%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Revenue by Sales Region */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">
            Revenue by Sales Region
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={regionDonutData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} (${(percent * 100).toFixed(0)}%)`
                  }
                  labelLine={false}
                >
                  {regionDonutData.map((entry, index) => (
                    <Cell
                      key={`region-${index}`}
                      fill={
                        REGION_COLORS[entry.name] ??
                        CHART_COLORS[index % CHART_COLORS.length]
                      }
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
                    "Revenue",
                  ]}
                  contentStyle={tooltipStyle}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-4 mt-2 flex-wrap">
            {regionDonutData.map((entry, i) => (
              <span key={entry.name} className="flex items-center gap-1 font-doodle text-sm">
                <span
                  className="w-3 h-3 rounded-full inline-block"
                  style={{
                    background:
                      REGION_COLORS[entry.name] ?? CHART_COLORS[i % CHART_COLORS.length],
                  }}
                />
                {entry.name}
              </span>
            ))}
          </div>
        </div>

        {/* Customers by Country */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">
            Customers by Country (Top 10)
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={topCountriesByCustomers}
                layout="vertical"
                margin={{ left: 10, right: 20 }}
              >
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fontFamily: "Short Stack", fontSize: 12 }}
                />
                <YAxis
                  type="category"
                  dataKey="country"
                  width={100}
                  tick={{ fontFamily: "Short Stack", fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value: number) => [
                    `${value.toLocaleString()} customers`,
                    "Count",
                  ]}
                  contentStyle={tooltipStyle}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {topCountriesByCustomers.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Spending Distribution */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">
            Spending Distribution
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={spendingBuckets}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} (${(percent * 100).toFixed(0)}%)`
                  }
                  labelLine={false}
                >
                  {spendingBuckets.map((_, index) => (
                    <Cell
                      key={`bucket-${index}`}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => [
                    `${value.toLocaleString()} customers`,
                    "Count",
                  ]}
                  contentStyle={tooltipStyle}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Monthly Revenue Trend — full width */}
        <div className="doodle-card p-4 lg:col-span-2">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-doodle-green" />
            Revenue Over Time
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={monthlyRevenue}
                margin={{ left: 10, right: 20, bottom: 20 }}
              >
                <defs>
                  <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(15, 80%, 55%)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(15, 80%, 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="monthLabel"
                  tick={{ fontFamily: "Short Stack", fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontFamily: "Short Stack", fontSize: 12 }}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
                    name === "cumulativeRevenue"
                      ? "Cumulative Revenue"
                      : "Monthly Revenue",
                  ]}
                  contentStyle={tooltipStyle}
                />
                <Area
                  type="monotone"
                  dataKey="cumulativeRevenue"
                  stroke="hsl(15, 80%, 55%)"
                  fill="url(#revenueGradient)"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="hsl(32, 50%, 70%)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-6 mt-2 text-sm font-doodle">
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(15,80%,55%)]" />
              Cumulative Revenue
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(32,50%,70%)]" />
              Monthly Revenue
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CustomerStatsDashboard;
