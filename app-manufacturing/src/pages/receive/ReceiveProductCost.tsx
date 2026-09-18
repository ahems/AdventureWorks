import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { fetchProduct, fetchProductCostHistory, fetchProductListPriceHistory } from '@/services/api';
import { ChartSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const ReceiveProductCost = () => {
  const { productId } = useParams();
  const pid = Number(productId);

  const { data: product } = useQuery({ queryKey: ['product', pid], queryFn: () => fetchProduct(pid) });
  const { data: costHistory, isLoading } = useQuery({ queryKey: ['cost-history', pid], queryFn: () => fetchProductCostHistory(pid) });
  const { data: priceHistory } = useQuery({ queryKey: ['price-history', pid], queryFn: () => fetchProductListPriceHistory(pid) });

  const chartData = useMemo(() => {
    const all = new Map<string, { date: string; cost?: number; price?: number }>();
    costHistory?.forEach(c => {
      const key = new Date(c.StartDate).toLocaleDateString();
      all.set(key, { ...all.get(key), date: key, cost: c.StandardCost });
    });
    priceHistory?.forEach(p => {
      const key = new Date(p.StartDate).toLocaleDateString();
      all.set(key, { ...all.get(key), date: key, price: p.ListPrice });
    });
    return Array.from(all.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [costHistory, priceHistory]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/receive/costing" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Cost Analysis
      </Link>

      <div className="doodle-card-static p-6">
        <h1 className="font-doodle text-2xl font-bold text-doodle-text">{product?.Name || `Product #${pid}`}</h1>
        <div className="flex gap-6 mt-2">
          <p className="font-doodle text-sm">Current Cost: <span className="font-bold text-doodle-green">${product?.StandardCost.toFixed(2)}</span></p>
          <p className="font-doodle text-sm">Current Price: <span className="font-bold text-doodle-accent">${product?.ListPrice.toFixed(2)}</span></p>
          {product && product.ListPrice > 0 && (
            <p className="font-doodle text-sm">Margin: <span className="font-bold">{(((product.ListPrice - product.StandardCost) / product.ListPrice) * 100).toFixed(1)}%</span></p>
          )}
        </div>
      </div>

      {isLoading ? (
        <><ChartSkeleton /><div className="grid md:grid-cols-2 gap-6"><TableSkeleton rows={4} cols={3} /><TableSkeleton rows={4} cols={3} /></div></>
      ) : chartData.length > 0 ? (
        <div className="doodle-card-static p-6">
          <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Cost vs Price Over Time</h2>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontFamily: 'Short Stack', fontSize: 11 }} />
              <YAxis tick={{ fontFamily: 'Short Stack', fontSize: 11 }} />
              <Tooltip contentStyle={{ fontFamily: 'Short Stack' }} />
              <Legend wrapperStyle={{ fontFamily: 'Short Stack' }} />
              <Line type="monotone" dataKey="cost" stroke="hsl(145 45% 35%)" strokeWidth={3} name="Standard Cost" dot={{ r: 4 }} />
              <Line type="monotone" dataKey="price" stroke="hsl(1 100% 68%)" strokeWidth={3} name="List Price" dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="font-doodle text-muted-foreground">No historical data found</p>
      )}

      {/* Raw data tables */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="doodle-card-static p-4">
          <h3 className="font-doodle text-sm font-bold mb-3">Cost History</h3>
          <table className="w-full font-doodle text-sm">
            <thead><tr className="border-b-2 border-doodle-text/20"><th className="text-left py-2 px-2">Start</th><th className="text-left py-2 px-2">End</th><th className="text-right py-2 px-2">Cost</th></tr></thead>
            <tbody>
              {costHistory && costHistory.length === 0 ? (
                <tr><td colSpan={3} className="py-3 px-2 text-center text-muted-foreground italic">No standard cost history recorded</td></tr>
              ) : costHistory?.map((c, i) => (
                <tr key={i} className="border-b border-doodle-text/10">
                  <td className="py-2 px-2">{new Date(c.StartDate).toLocaleDateString()}</td>
                  <td className="py-2 px-2">{c.EndDate ? new Date(c.EndDate).toLocaleDateString() : 'Current'}</td>
                  <td className="text-right py-2 px-2 font-bold">${c.StandardCost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="doodle-card-static p-4">
          <h3 className="font-doodle text-sm font-bold mb-3">Price History</h3>
          <table className="w-full font-doodle text-sm">
            <thead><tr className="border-b-2 border-doodle-text/20"><th className="text-left py-2 px-2">Start</th><th className="text-left py-2 px-2">End</th><th className="text-right py-2 px-2">Price</th></tr></thead>
            <tbody>
              {priceHistory?.map((p, i) => (
                <tr key={i} className="border-b border-doodle-text/10">
                  <td className="py-2 px-2">{new Date(p.StartDate).toLocaleDateString()}</td>
                  <td className="py-2 px-2">{p.EndDate ? new Date(p.EndDate).toLocaleDateString() : 'Current'}</td>
                  <td className="text-right py-2 px-2 font-bold">${p.ListPrice.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ReceiveProductCost;
