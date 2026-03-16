import React, { useMemo } from "react";
import { Customer } from "@/types/customer";
import CountryFlag from "@/components/CountryFlag";
import { Users, TrendingUp } from "lucide-react";

interface CustomerCountryMapProps {
  customers: Customer[];
}

interface CountryStats {
  country: string;
  count: number;
  totalSpent: number;
  percentage: number;
}

// Approximate coordinates for countries on the map (as percentages)
const countryPositions: Record<string, { x: number; y: number }> = {
  "United States": { x: 20, y: 40 },
  Canada: { x: 18, y: 28 },
  Mexico: { x: 15, y: 52 },
  Brazil: { x: 32, y: 70 },
  "United Kingdom": { x: 47, y: 32 },
  France: { x: 49, y: 38 },
  Germany: { x: 52, y: 35 },
  Italy: { x: 53, y: 42 },
  Spain: { x: 46, y: 44 },
  Netherlands: { x: 50, y: 33 },
  Sweden: { x: 55, y: 25 },
  Norway: { x: 52, y: 22 },
  Denmark: { x: 52, y: 30 },
  Poland: { x: 56, y: 34 },
  Austria: { x: 54, y: 38 },
  Switzerland: { x: 51, y: 38 },
  Belgium: { x: 49, y: 35 },
  Portugal: { x: 44, y: 44 },
  Ireland: { x: 44, y: 32 },
  Japan: { x: 88, y: 42 },
  China: { x: 78, y: 42 },
  "South Korea": { x: 84, y: 42 },
  India: { x: 72, y: 52 },
  Australia: { x: 85, y: 78 },
  "New Zealand": { x: 92, y: 82 },
  "South Africa": { x: 56, y: 78 },
  Singapore: { x: 78, y: 60 },
  Argentina: { x: 28, y: 82 },
  Chile: { x: 26, y: 80 },
  Colombia: { x: 25, y: 58 },
};

const CustomerCountryMap: React.FC<CustomerCountryMapProps> = ({
  customers,
}) => {
  const countryStats = useMemo(() => {
    const stats: Record<string, { count: number; totalSpent: number }> = {};

    customers.forEach((customer) => {
      if (!stats[customer.Country]) {
        stats[customer.Country] = { count: 0, totalSpent: 0 };
      }
      stats[customer.Country].count++;
      stats[customer.Country].totalSpent += customer.TotalSpent;
    });

    const total = customers.length;
    const result: CountryStats[] = Object.entries(stats)
      .map(([country, data]) => ({
        country,
        count: data.count,
        totalSpent: data.totalSpent,
        percentage: (data.count / total) * 100,
      }))
      .sort((a, b) => b.count - a.count);

    return result;
  }, [customers]);

  const maxCount = Math.max(...countryStats.map((s) => s.count));

  return (
    <section className="container mx-auto px-4 pb-8">
      <div className="doodle-card p-6">
        <h2 className="font-doodle text-xl font-bold text-doodle-text mb-6 flex items-center gap-2">
          🌍 Customer Distribution by Country
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Map Visualization */}
          <div className="relative bg-doodle-accent/5 border-2 border-doodle-text/20 rounded-lg p-4 min-h-[300px]">
            {/* Simple world outline */}
            <svg
              viewBox="0 0 100 100"
              className="w-full h-full absolute inset-0 opacity-10"
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Simplified continent outlines */}
              <ellipse
                cx="20"
                cy="42"
                rx="15"
                ry="20"
                fill="currentColor"
                className="text-doodle-text"
              />
              <ellipse
                cx="30"
                cy="72"
                rx="10"
                ry="18"
                fill="currentColor"
                className="text-doodle-text"
              />
              <ellipse
                cx="52"
                cy="38"
                rx="12"
                ry="15"
                fill="currentColor"
                className="text-doodle-text"
              />
              <ellipse
                cx="58"
                cy="68"
                rx="8"
                ry="12"
                fill="currentColor"
                className="text-doodle-text"
              />
              <ellipse
                cx="75"
                cy="48"
                rx="15"
                ry="18"
                fill="currentColor"
                className="text-doodle-text"
              />
              <ellipse
                cx="85"
                cy="78"
                rx="8"
                ry="6"
                fill="currentColor"
                className="text-doodle-text"
              />
            </svg>

            {/* Country markers */}
            {countryStats.map((stat) => {
              const pos = countryPositions[stat.country];
              if (!pos) return null;

              const size = 12 + (stat.count / maxCount) * 20;

              return (
                <div
                  key={stat.country}
                  className="absolute transform -translate-x-1/2 -translate-y-1/2 group cursor-pointer"
                  style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                >
                  <div
                    className="rounded-full bg-doodle-accent border-2 border-doodle-text flex items-center justify-center text-white font-doodle font-bold shadow-lg hover:scale-110 transition-transform"
                    style={{
                      width: `${size}px`,
                      height: `${size}px`,
                      fontSize: `${Math.max(10, size * 0.4)}px`,
                    }}
                  >
                    {stat.count}
                  </div>

                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                    <div className="bg-doodle-text text-white px-3 py-2 rounded-lg shadow-lg whitespace-nowrap">
                      <div className="font-doodle font-bold flex items-center gap-2">
                        <CountryFlag country={stat.country} /> {stat.country}
                      </div>
                      <div className="font-doodle text-xs mt-1">
                        {stat.count} customer{stat.count !== 1 ? "s" : ""} • $
                        {stat.totalSpent.toFixed(0)}
                      </div>
                    </div>
                    <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-doodle-text" />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Country List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm font-doodle text-doodle-text/60 pb-2 border-b-2 border-dashed border-doodle-text/20">
              <span>Country</span>
              <span>Customers / Revenue</span>
            </div>

            {countryStats.map((stat, index) => (
              <div key={stat.country} className="flex items-center gap-3">
                <span className="font-doodle text-doodle-text/50 w-6 text-right">
                  {index + 1}.
                </span>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-doodle text-doodle-text flex items-center gap-2">
                      <CountryFlag country={stat.country} />
                      {stat.country}
                    </span>
                    <div className="text-right">
                      <span className="font-doodle font-bold text-doodle-text flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {stat.count}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-doodle-text/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-doodle-accent rounded-full transition-all"
                        style={{ width: `${stat.percentage}%` }}
                      />
                    </div>
                    <span className="font-doodle text-xs text-doodle-green flex items-center gap-1 w-20 justify-end">
                      <TrendingUp className="w-3 h-3" />$
                      {stat.totalSpent.toFixed(0)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default CustomerCountryMap;
