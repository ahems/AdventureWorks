import React, { useMemo } from 'react';
import { Users, DollarSign, TrendingUp, MapPin, Calendar } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, Area, AreaChart } from 'recharts';
import { Customer, mockOrders, Order } from '@/data/mockCustomers';
import { format, parseISO, startOfMonth, endOfMonth, eachMonthOfInterval, isWithinInterval } from 'date-fns';

interface CustomerStatsDashboardProps {
  customers: Customer[];
}

const CHART_COLORS = [
  'hsl(15, 80%, 55%)',   // primary/orange
  'hsl(145, 45%, 35%)',  // accent/green
  'hsl(217, 100%, 67%)', // blue
  'hsl(32, 50%, 70%)',   // warm
  'hsl(0, 72%, 51%)',    // red
  'hsl(280, 60%, 50%)',  // purple
  'hsl(45, 90%, 50%)',   // yellow
  'hsl(180, 50%, 45%)',  // teal
];

const CustomerStatsDashboard: React.FC<CustomerStatsDashboardProps> = ({ customers }) => {
  // Total customers
  const totalCustomers = customers.length;

  // Total revenue
  const totalRevenue = useMemo(() => 
    customers.reduce((sum, c) => sum + c.TotalSpent, 0), [customers]);

  // Average spending
  const avgSpending = totalCustomers > 0 ? totalRevenue / totalCustomers : 0;

  // Revenue by state
  const revenueByState = useMemo(() => {
    const stateMap: Record<string, number> = {};
    customers.forEach(c => {
      stateMap[c.StateProvince] = (stateMap[c.StateProvince] || 0) + c.TotalSpent;
    });
    return Object.entries(stateMap)
      .map(([state, revenue]) => ({ state, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [customers]);

  // Spending distribution (pie chart data)
  const spendingDistribution = useMemo(() => {
    const ranges = [
      { name: 'Under $1K', min: 0, max: 1000, count: 0 },
      { name: '$1K - $5K', min: 1000, max: 5000, count: 0 },
      { name: '$5K - $10K', min: 5000, max: 10000, count: 0 },
      { name: 'Over $10K', min: 10000, max: Infinity, count: 0 },
    ];
    customers.forEach(c => {
      for (const range of ranges) {
        if (c.TotalSpent >= range.min && c.TotalSpent < range.max) {
          range.count++;
          break;
        }
      }
    });
    return ranges.filter(r => r.count > 0).map(r => ({ name: r.name, value: r.count }));
  }, [customers]);

  // Customers by state (for pie chart)
  const customersByState = useMemo(() => {
    const stateMap: Record<string, number> = {};
    customers.forEach(c => {
      stateMap[c.StateProvince] = (stateMap[c.StateProvince] || 0) + 1;
    });
    return Object.entries(stateMap)
      .map(([state, count]) => ({ name: state, value: count }))
      .sort((a, b) => b.value - a.value);
  }, [customers]);

  // Customer acquisition over time
  const customerAcquisitionTrend = useMemo(() => {
    if (customers.length === 0) return [];
    
    const dates = customers.map(c => parseISO(c.CreatedAt));
    const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
    
    const months = eachMonthOfInterval({ start: minDate, end: maxDate });
    
    let cumulative = 0;
    return months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      
      const newCustomers = customers.filter(c => {
        const createdDate = parseISO(c.CreatedAt);
        return isWithinInterval(createdDate, { start: monthStart, end: monthEnd });
      }).length;
      
      cumulative += newCustomers;
      
      return {
        month: format(month, 'MMM yyyy'),
        newCustomers,
        totalCustomers: cumulative,
      };
    });
  }, [customers]);

  // Revenue growth over time
  const revenueGrowthTrend = useMemo(() => {
    const orders = mockOrders;
    if (orders.length === 0) return [];
    
    const dates = orders.map(o => parseISO(o.OrderDate));
    const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
    
    const months = eachMonthOfInterval({ start: minDate, end: maxDate });
    
    let cumulative = 0;
    return months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      
      const monthlyRevenue = orders
        .filter(o => {
          const orderDate = parseISO(o.OrderDate);
          return isWithinInterval(orderDate, { start: monthStart, end: monthEnd });
        })
        .reduce((sum, o) => sum + o.TotalDue, 0);
      
      cumulative += monthlyRevenue;
      
      return {
        month: format(month, 'MMM yyyy'),
        revenue: monthlyRevenue,
        cumulativeRevenue: cumulative,
      };
    });
  }, []);

  return (
    <section className="container mx-auto px-4 pb-8">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-doodle-accent/20 flex items-center justify-center rounded">
              <Users className="w-5 h-5 text-doodle-accent" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Total Customers</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">{totalCustomers}</p>
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
              <p className="font-doodle text-2xl font-bold text-doodle-green">${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
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
              <p className="font-doodle text-2xl font-bold text-doodle-text">${avgSpending.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
          </div>
        </div>

        <div className="doodle-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-500/20 flex items-center justify-center rounded">
              <MapPin className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className="font-doodle text-sm text-doodle-text/60">Active States</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">{revenueByState.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by State Bar Chart */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">Revenue by State</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueByState} layout="vertical" margin={{ left: 10, right: 20 }}>
                <XAxis 
                  type="number" 
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                />
                <YAxis 
                  type="category" 
                  dataKey="state" 
                  width={40}
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                />
                <Tooltip
                  formatter={(value: number) => [`$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 'Revenue']}
                  contentStyle={{ fontFamily: 'Short Stack', border: '2px solid #3c3c3c', borderRadius: '4px' }}
                />
                <Bar dataKey="revenue" fill="hsl(15, 80%, 55%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Spending Distribution Pie Chart */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">Spending Distribution</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={spendingDistribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={false}
                >
                  {spendingDistribution.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => [`${value} customers`, 'Count']}
                  contentStyle={{ fontFamily: 'Short Stack', border: '2px solid #3c3c3c', borderRadius: '4px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Customers by State Pie Chart */}
        <div className="doodle-card p-4 lg:col-span-2">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4">Customers by State</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={customersByState} margin={{ left: 10, right: 20, bottom: 20 }}>
                <XAxis 
                  dataKey="name" 
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                />
                <YAxis 
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value: number) => [`${value} customers`, 'Count']}
                  contentStyle={{ fontFamily: 'Short Stack', border: '2px solid #3c3c3c', borderRadius: '4px' }}
                />
                <Bar dataKey="value" fill="hsl(145, 45%, 35%)" radius={[4, 4, 0, 0]}>
                  {customersByState.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Customer Acquisition Trend */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-doodle-accent" />
            Customer Acquisition Trend
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={customerAcquisitionTrend} margin={{ left: 10, right: 20, bottom: 20 }}>
                <defs>
                  <linearGradient id="customerGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(145, 45%, 35%)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(145, 45%, 35%)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="month" 
                  tick={{ fontFamily: 'Short Stack', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis 
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    value,
                    name === 'totalCustomers' ? 'Total Customers' : 'New Customers'
                  ]}
                  contentStyle={{ fontFamily: 'Short Stack', border: '2px solid #3c3c3c', borderRadius: '4px' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="totalCustomers" 
                  stroke="hsl(145, 45%, 35%)" 
                  fill="url(#customerGradient)" 
                  strokeWidth={2}
                />
                <Line 
                  type="monotone" 
                  dataKey="newCustomers" 
                  stroke="hsl(217, 100%, 67%)" 
                  strokeWidth={2}
                  dot={{ fill: 'hsl(217, 100%, 67%)', strokeWidth: 0, r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-6 mt-2 text-sm font-doodle">
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(145,45%,35%)]"></span>
              Total Customers
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(217,100%,67%)]"></span>
              New Customers
            </span>
          </div>
        </div>

        {/* Revenue Growth Trend */}
        <div className="doodle-card p-4">
          <h3 className="font-doodle font-bold text-lg text-doodle-text mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-doodle-green" />
            Revenue Growth Over Time
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueGrowthTrend} margin={{ left: 10, right: 20, bottom: 20 }}>
                <defs>
                  <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(15, 80%, 55%)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(15, 80%, 55%)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="month" 
                  tick={{ fontFamily: 'Short Stack', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis 
                  tick={{ fontFamily: 'Short Stack', fontSize: 12 }}
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                    name === 'cumulativeRevenue' ? 'Cumulative Revenue' : 'Monthly Revenue'
                  ]}
                  contentStyle={{ fontFamily: 'Short Stack', border: '2px solid #3c3c3c', borderRadius: '4px' }}
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
                  dot={{ fill: 'hsl(32, 50%, 70%)', strokeWidth: 0, r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-6 mt-2 text-sm font-doodle">
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(15,80%,55%)]"></span>
              Cumulative Revenue
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[hsl(32,50%,70%)]"></span>
              Monthly Revenue
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CustomerStatsDashboard;
