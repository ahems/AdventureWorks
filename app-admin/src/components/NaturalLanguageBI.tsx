import React, { useState } from 'react';
import { Search, Sparkles, Loader2, BarChart3, PieChart, TrendingUp, Users, ShoppingBag, Package, HelpCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import BIResultsChart from '@/components/BIResultsChart';
import { mockCustomers, mockOrders } from '@/data/mockCustomers';
import { products, categories } from '@/data/mockData';

interface BIQuery {
  id: string;
  query: string;
  timestamp: Date;
  result: BIResult | null;
}

interface BIResult {
  type: 'bar' | 'pie' | 'line' | 'table' | 'metric';
  title: string;
  insight: string;
  data: any[];
  dataKey?: string;
  nameKey?: string;
}

const suggestedQueries = [
  { label: 'Top Customers', query: 'Show me top customers by total spend', icon: Users },
  { label: 'Orders by Status', query: 'What is the breakdown of orders by status?', icon: PieChart },
  { label: 'Revenue by State', query: 'Show me revenue by state', icon: BarChart3 },
  { label: 'Product Sales', query: 'Which product categories sell the most?', icon: Package },
  { label: 'Recent Orders', query: 'List recent orders', icon: ShoppingBag },
  { label: 'Sales Trend', query: 'Show me the sales trend', icon: TrendingUp },
];

const processQuery = (query: string): BIResult => {
  const lowerQuery = query.toLowerCase();

  // Top Customers
  if (lowerQuery.includes('customer') && (lowerQuery.includes('top') || lowerQuery.includes('best') || lowerQuery.includes('spend'))) {
    const topCustomers = [...mockCustomers]
      .sort((a, b) => b.TotalSpent - a.TotalSpent)
      .slice(0, 5)
      .map(c => ({
        name: `${c.FirstName} ${c.LastName}`,
        value: c.TotalSpent,
        orders: c.TotalOrders,
        city: c.City
      }));

    return {
      type: 'bar',
      title: 'Top 5 Customers by Total Spend',
      insight: `🏆 ${topCustomers[0].name} leads with $${topCustomers[0].value.toLocaleString()} in purchases. The top 5 customers account for $${topCustomers.reduce((sum, c) => sum + c.value, 0).toLocaleString()} in total revenue.`,
      data: topCustomers,
      dataKey: 'value',
      nameKey: 'name'
    };
  }

  // Orders by Status
  if (lowerQuery.includes('order') && lowerQuery.includes('status')) {
    const statusCounts = mockOrders.reduce((acc, order) => {
      acc[order.Status] = (acc[order.Status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const data = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

    return {
      type: 'pie',
      title: 'Orders by Status',
      insight: `📊 You have ${mockOrders.length} total orders. ${statusCounts['Pending'] || 0} are pending attention and ${statusCounts['Delivered'] || 0} have been successfully delivered.`,
      data,
      dataKey: 'value',
      nameKey: 'name'
    };
  }

  // Revenue by State
  if (lowerQuery.includes('revenue') && lowerQuery.includes('state')) {
    const stateRevenue: Record<string, number> = {};
    mockOrders.forEach(order => {
      const customer = mockCustomers.find(c => c.CustomerID === order.CustomerID);
      if (customer) {
        stateRevenue[customer.StateProvince] = (stateRevenue[customer.StateProvince] || 0) + order.TotalDue;
      }
    });

    const data = Object.entries(stateRevenue)
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const topState = data[0];
    return {
      type: 'bar',
      title: 'Revenue by State/Region',
      insight: `📍 ${topState.name} leads with $${topState.value.toLocaleString()} in revenue. Total revenue across all regions: $${Object.values(stateRevenue).reduce((a, b) => a + b, 0).toLocaleString()}.`,
      data,
      dataKey: 'value',
      nameKey: 'name'
    };
  }

  // Product Categories
  if (lowerQuery.includes('product') || lowerQuery.includes('categor')) {
    const categoryData = categories.map(cat => {
      const categoryProducts = products.filter(p => {
        const subcatIds = cat.ProductCategoryID === 1 ? [1, 2, 3] 
          : cat.ProductCategoryID === 2 ? [4, 5, 6, 7]
          : cat.ProductCategoryID === 3 ? [8, 9, 10]
          : [11, 12, 13];
        return p.ProductSubcategoryID && subcatIds.includes(p.ProductSubcategoryID);
      });
      return {
        name: cat.Name,
        value: categoryProducts.length,
        avgPrice: categoryProducts.length > 0 
          ? Math.round(categoryProducts.reduce((sum, p) => sum + p.ListPrice, 0) / categoryProducts.length)
          : 0
      };
    });

    return {
      type: 'pie',
      title: 'Products by Category',
      insight: `🚲 The ${categoryData[0].name} category has ${categoryData[0].value} products with an average price of $${categoryData[0].avgPrice}. You have ${products.length} total products across all categories.`,
      data: categoryData,
      dataKey: 'value',
      nameKey: 'name'
    };
  }

  // Recent Orders
  if (lowerQuery.includes('recent') || lowerQuery.includes('list')) {
    const recentOrders = [...mockOrders]
      .sort((a, b) => new Date(b.OrderDate).getTime() - new Date(a.OrderDate).getTime())
      .slice(0, 5)
      .map(o => {
        const customer = mockCustomers.find(c => c.CustomerID === o.CustomerID);
        return {
          id: o.SalesOrderID,
          customer: customer ? `${customer.FirstName} ${customer.LastName}` : 'Unknown',
          date: new Date(o.OrderDate).toLocaleDateString(),
          status: o.Status,
          total: o.TotalDue
        };
      });

    return {
      type: 'table',
      title: 'Recent Orders',
      insight: `📦 Showing the 5 most recent orders. Total value: $${recentOrders.reduce((sum, o) => sum + o.total, 0).toLocaleString()}.`,
      data: recentOrders
    };
  }

  // Sales Trend
  if (lowerQuery.includes('trend') || lowerQuery.includes('time') || lowerQuery.includes('month')) {
    // Simulate monthly data
    const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
    const data = months.map((month, i) => ({
      name: month,
      value: Math.round(15000 + Math.random() * 10000 + i * 2000)
    }));

    return {
      type: 'line',
      title: 'Sales Trend (Last 6 Months)',
      insight: `📈 Sales have grown ${Math.round(((data[5].value - data[0].value) / data[0].value) * 100)}% over the past 6 months. Peak month: ${data.reduce((max, d) => d.value > max.value ? d : max).name}.`,
      data,
      dataKey: 'value',
      nameKey: 'name'
    };
  }

  // Default fallback
  return {
    type: 'metric',
    title: 'Quick Stats',
    insight: `💡 Try asking about "top customers", "orders by status", "revenue by state", or "product categories". I'm here to help visualize your data!`,
    data: [
      { label: 'Total Products', value: products.length },
      { label: 'Total Customers', value: mockCustomers.length },
      { label: 'Total Orders', value: mockOrders.length },
      { label: 'Total Revenue', value: `$${mockOrders.reduce((sum, o) => sum + o.TotalDue, 0).toLocaleString()}` }
    ]
  };
};

const NaturalLanguageBI: React.FC = () => {
  const [query, setQuery] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentResult, setCurrentResult] = useState<BIResult | null>(null);
  const [queryHistory, setQueryHistory] = useState<BIQuery[]>([]);

  const handleQuery = (queryText: string) => {
    if (!queryText.trim()) return;

    setIsProcessing(true);
    setQuery(queryText);

    // Simulate AI processing
    setTimeout(() => {
      const result = processQuery(queryText);
      setCurrentResult(result);
      setQueryHistory(prev => [{
        id: Date.now().toString(),
        query: queryText,
        timestamp: new Date(),
        result
      }, ...prev.slice(0, 4)]);
      setIsProcessing(false);
    }, 1200);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleQuery(query);
  };

  return (
    <div className="doodle-card p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-doodle-accent to-doodle-green flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="font-doodle text-xl font-bold text-doodle-text">Ask Your Data Anything</h2>
          <p className="font-doodle text-sm text-doodle-text/60">Natural language business intelligence</p>
        </div>
      </div>

      {/* Query Input */}
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/40" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g., 'Show me top customers by spend' or 'What's our order status breakdown?'"
              className="pl-10 font-doodle border-2 border-doodle-text"
              disabled={isProcessing}
            />
          </div>
          <Button
            type="submit"
            disabled={!query.trim() || isProcessing}
            className="doodle-button doodle-button-primary px-6"
          >
            {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Ask'}
          </Button>
        </div>
      </form>

      {/* Suggested Queries */}
      <div className="flex flex-wrap gap-2 mb-6">
        {suggestedQueries.map((sq) => (
          <button
            key={sq.label}
            onClick={() => handleQuery(sq.query)}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-doodle text-sm border-2 border-doodle-text/30 text-doodle-text/70 hover:border-doodle-accent hover:text-doodle-accent transition-colors rounded-full disabled:opacity-50"
          >
            <sq.icon className="w-3.5 h-3.5" />
            {sq.label}
          </button>
        ))}
      </div>

      {/* Results */}
      {isProcessing && (
        <div className="text-center py-12">
          <Loader2 className="w-10 h-10 animate-spin text-doodle-accent mx-auto mb-3" />
          <p className="font-doodle text-doodle-text/60">Analyzing your data...</p>
        </div>
      )}

      {!isProcessing && currentResult && (
        <div className="space-y-4">
          <div className="border-2 border-doodle-text/20 rounded-lg p-4">
            <h3 className="font-doodle font-bold text-lg text-doodle-text mb-2">{currentResult.title}</h3>
            <BIResultsChart result={currentResult} />
          </div>

          {/* AI Insight */}
          <div className="bg-gradient-to-r from-doodle-accent/10 to-doodle-green/10 border-2 border-dashed border-doodle-accent/30 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <Sparkles className="w-5 h-5 text-doodle-accent shrink-0 mt-0.5" />
              <div>
                <p className="font-doodle text-xs text-doodle-accent font-bold mb-1">AI INSIGHT</p>
                <p className="font-doodle text-sm text-doodle-text">{currentResult.insight}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isProcessing && !currentResult && (
        <div className="text-center py-8 border-2 border-dashed border-doodle-text/20 rounded-lg">
          <HelpCircle className="w-10 h-10 text-doodle-text/30 mx-auto mb-3" />
          <p className="font-doodle text-doodle-text/60">Ask a question or click a suggestion above</p>
          <p className="font-doodle text-sm text-doodle-text/40 mt-1">I'll analyze your data and create visualizations</p>
        </div>
      )}

      {/* Query History */}
      {queryHistory.length > 0 && (
        <div className="mt-6 pt-4 border-t-2 border-dashed border-doodle-text/20">
          <p className="font-doodle text-xs text-doodle-text/50 mb-2">Recent queries:</p>
          <div className="flex flex-wrap gap-2">
            {queryHistory.map((q) => (
              <button
                key={q.id}
                onClick={() => handleQuery(q.query)}
                className="font-doodle text-xs text-doodle-text/60 hover:text-doodle-accent truncate max-w-xs"
              >
                "{q.query}"
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default NaturalLanguageBI;
