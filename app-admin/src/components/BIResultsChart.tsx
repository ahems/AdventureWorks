import React from 'react';
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
  LineChart,
  Line,
  Legend
} from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface BIResult {
  type: 'bar' | 'pie' | 'line' | 'table' | 'metric';
  title: string;
  insight: string;
  data: any[];
  dataKey?: string;
  nameKey?: string;
}

interface BIResultsChartProps {
  result: BIResult;
}

const COLORS = [
  'hsl(var(--doodle-accent))',
  'hsl(var(--doodle-green))',
  'hsl(var(--doodle-blue))',
  'hsl(var(--doodle-yellow))',
  '#8884d8',
  '#82ca9d',
  '#ffc658',
  '#ff7c43'
];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border-2 border-doodle-text p-2 shadow-lg">
        <p className="font-doodle text-sm font-bold text-doodle-text">{label}</p>
        <p className="font-doodle text-sm text-doodle-accent">
          {typeof payload[0].value === 'number' 
            ? `$${payload[0].value.toLocaleString()}`
            : payload[0].value}
        </p>
      </div>
    );
  }
  return null;
};

const BIResultsChart: React.FC<BIResultsChartProps> = ({ result }) => {
  const { type, data, dataKey = 'value', nameKey = 'name' } = result;

  if (type === 'bar') {
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--doodle-text) / 0.1)" />
            <XAxis 
              dataKey={nameKey} 
              tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
              stroke="hsl(var(--doodle-text))"
            />
            <YAxis 
              tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
              stroke="hsl(var(--doodle-text))"
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar 
              dataKey={dataKey} 
              fill="hsl(var(--doodle-accent))"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === 'pie') {
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey={dataKey}
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              outerRadius={80}
              label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
              labelLine={{ stroke: 'hsl(var(--doodle-text))' }}
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend 
              formatter={(value) => <span className="font-doodle text-sm">{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === 'line') {
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--doodle-text) / 0.1)" />
            <XAxis 
              dataKey={nameKey}
              tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
              stroke="hsl(var(--doodle-text))"
            />
            <YAxis 
              tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
              stroke="hsl(var(--doodle-text))"
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line 
              type="monotone" 
              dataKey={dataKey} 
              stroke="hsl(var(--doodle-accent))"
              strokeWidth={3}
              dot={{ fill: 'hsl(var(--doodle-accent))', strokeWidth: 2 }}
              activeDot={{ r: 6, fill: 'hsl(var(--doodle-green))' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === 'table') {
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {Object.keys(data[0] || {}).map((key) => (
                <TableHead key={key} className="font-doodle capitalize">
                  {key.replace(/([A-Z])/g, ' $1').trim()}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row, i) => (
              <TableRow key={i}>
                {Object.values(row).map((value: any, j) => (
                  <TableCell key={j} className="font-doodle">
                    {typeof value === 'number' && j === Object.keys(row).indexOf('total')
                      ? `$${value.toLocaleString()}`
                      : String(value)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (type === 'metric') {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {data.map((item, i) => (
          <div 
            key={i} 
            className="text-center p-4 border-2 border-doodle-text/20 rounded-lg"
          >
            <p className="font-doodle text-2xl font-bold text-doodle-accent">{item.value}</p>
            <p className="font-doodle text-sm text-doodle-text/60">{item.label}</p>
          </div>
        ))}
      </div>
    );
  }

  return null;
};

export default BIResultsChart;
