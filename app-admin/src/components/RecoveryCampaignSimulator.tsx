import React, { useState } from 'react';
import { Play, TrendingUp, DollarSign, Mail, Users, Percent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell,
  Legend
} from 'recharts';

interface CartStrategy {
  cart: {
    ShoppingCartID: string;
    customerEmail: string;
    customerName: string;
    totalItems: number;
    totalValue: number;
    daysStale: number;
  };
  recoveryScore: number;
  urgency: 'high' | 'medium' | 'low';
  strategy: string;
  recommendedDiscount: number;
  emailSubject: string;
  emailPreview: string;
}

interface RecoveryCampaignSimulatorProps {
  strategies: CartStrategy[];
}

interface SimulationResult {
  scenario: string;
  emailsSent: number;
  expectedOpens: number;
  expectedClicks: number;
  expectedConversions: number;
  expectedRevenue: number;
  discountCost: number;
  netRevenue: number;
}

const RecoveryCampaignSimulator: React.FC<RecoveryCampaignSimulatorProps> = ({ strategies }) => {
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationComplete, setSimulationComplete] = useState(false);
  const [results, setResults] = useState<SimulationResult[]>([]);

  const runSimulation = () => {
    setIsSimulating(true);
    setSimulationComplete(false);

    // Simulate campaign scenarios
    setTimeout(() => {
      const highPriority = strategies.filter(s => s.urgency === 'high');
      const mediumPriority = strategies.filter(s => s.urgency === 'medium');
      const lowPriority = strategies.filter(s => s.urgency === 'low');

      const simulatedResults: SimulationResult[] = [
        {
          scenario: 'High Priority Only',
          emailsSent: highPriority.length,
          expectedOpens: Math.round(highPriority.length * 0.65),
          expectedClicks: Math.round(highPriority.length * 0.35),
          expectedConversions: Math.round(highPriority.length * 0.25),
          expectedRevenue: highPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.35, 0),
          discountCost: highPriority.reduce((sum, s) => sum + s.cart.totalValue * (s.recommendedDiscount / 100) * 0.35, 0),
          netRevenue: 0
        },
        {
          scenario: 'High + Medium Priority',
          emailsSent: highPriority.length + mediumPriority.length,
          expectedOpens: Math.round((highPriority.length * 0.65) + (mediumPriority.length * 0.45)),
          expectedClicks: Math.round((highPriority.length * 0.35) + (mediumPriority.length * 0.20)),
          expectedConversions: Math.round((highPriority.length * 0.25) + (mediumPriority.length * 0.12)),
          expectedRevenue: highPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.35, 0) + 
                           mediumPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.15, 0),
          discountCost: highPriority.reduce((sum, s) => sum + s.cart.totalValue * (s.recommendedDiscount / 100) * 0.35, 0) +
                        mediumPriority.reduce((sum, s) => sum + s.cart.totalValue * (s.recommendedDiscount / 100) * 0.15, 0),
          netRevenue: 0
        },
        {
          scenario: 'All Carts',
          emailsSent: strategies.length,
          expectedOpens: Math.round((highPriority.length * 0.65) + (mediumPriority.length * 0.45) + (lowPriority.length * 0.25)),
          expectedClicks: Math.round((highPriority.length * 0.35) + (mediumPriority.length * 0.20) + (lowPriority.length * 0.08)),
          expectedConversions: Math.round((highPriority.length * 0.25) + (mediumPriority.length * 0.12) + (lowPriority.length * 0.03)),
          expectedRevenue: highPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.35, 0) + 
                           mediumPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.15, 0) +
                           lowPriority.reduce((sum, s) => sum + s.cart.totalValue * 0.05, 0),
          discountCost: strategies.reduce((sum, s) => sum + s.cart.totalValue * (s.recommendedDiscount / 100) * 
                        (s.urgency === 'high' ? 0.35 : s.urgency === 'medium' ? 0.15 : 0.05), 0),
          netRevenue: 0
        }
      ];

      // Calculate net revenue
      simulatedResults.forEach(r => {
        r.netRevenue = r.expectedRevenue - r.discountCost;
      });

      setResults(simulatedResults);
      setIsSimulating(false);
      setSimulationComplete(true);
    }, 1500);
  };

  const chartData = results.map(r => ({
    name: r.scenario,
    'Gross Revenue': Math.round(r.expectedRevenue),
    'Net Revenue': Math.round(r.netRevenue),
    'Discount Cost': Math.round(r.discountCost)
  }));

  const bestScenario = results.reduce((best, current) => 
    current.netRevenue > best.netRevenue ? current : best, 
    results[0] || { scenario: '', netRevenue: 0 }
  );

  return (
    <div className="doodle-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-doodle-blue/20 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-doodle-blue" />
          </div>
          <div>
            <h3 className="font-doodle text-lg font-bold text-doodle-text">Campaign Simulator</h3>
            <p className="font-doodle text-sm text-doodle-text/60">Project recovery outcomes before sending</p>
          </div>
        </div>

        {!simulationComplete && (
          <Button
            onClick={runSimulation}
            disabled={isSimulating}
            className="doodle-button doodle-button-primary"
          >
            {isSimulating ? (
              <>Simulating...</>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Run Simulation
              </>
            )}
          </Button>
        )}
      </div>

      {isSimulating && (
        <div className="text-center py-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-doodle-accent/10 flex items-center justify-center">
            <TrendingUp className="w-8 h-8 text-doodle-accent animate-pulse" />
          </div>
          <p className="font-doodle text-doodle-text/60">Running campaign simulations...</p>
          <Progress value={66} className="w-48 mx-auto mt-3" />
        </div>
      )}

      {simulationComplete && results.length > 0 && (
        <div className="space-y-6">
          {/* Recommendation */}
          <div className="bg-gradient-to-r from-doodle-green/10 to-doodle-accent/10 border-2 border-dashed border-doodle-green/30 rounded-lg p-4">
            <p className="font-doodle text-xs text-doodle-green font-bold uppercase mb-1">
              AI Recommendation
            </p>
            <p className="font-doodle text-doodle-text">
              The <strong>"{bestScenario.scenario}"</strong> approach yields the highest net revenue of{' '}
              <strong className="text-doodle-green">${Math.round(bestScenario.netRevenue).toLocaleString()}</strong>.
              This is the recommended strategy for maximum ROI.
            </p>
          </div>

          {/* Chart */}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--doodle-text) / 0.1)" />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
                  stroke="hsl(var(--doodle-text))"
                />
                <YAxis 
                  tick={{ fontSize: 12, fontFamily: 'Patrick Hand' }}
                  stroke="hsl(var(--doodle-text))"
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                />
                <Tooltip 
                  contentStyle={{ 
                    fontFamily: 'Patrick Hand',
                    border: '2px solid hsl(var(--doodle-text))'
                  }}
                  formatter={(value: number) => [`$${value.toLocaleString()}`, '']}
                />
                <Legend formatter={(value) => <span className="font-doodle">{value}</span>} />
                <Bar dataKey="Gross Revenue" fill="hsl(var(--doodle-accent))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Net Revenue" fill="hsl(var(--doodle-green))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Scenario Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {results.map((result, i) => (
              <div 
                key={result.scenario}
                className={`border-2 rounded-lg p-4 ${
                  result.scenario === bestScenario.scenario 
                    ? 'border-doodle-green bg-doodle-green/5' 
                    : 'border-doodle-text/20'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-doodle font-bold text-doodle-text">{result.scenario}</h4>
                  {result.scenario === bestScenario.scenario && (
                    <span className="font-doodle text-xs bg-doodle-green text-white px-2 py-0.5 rounded">
                      BEST
                    </span>
                  )}
                </div>
                
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-doodle-text/60">
                      <Mail className="w-3 h-3" /> Emails
                    </span>
                    <span className="font-doodle font-bold text-doodle-text">{result.emailsSent}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-doodle-text/60">
                      <Users className="w-3 h-3" /> Est. Conversions
                    </span>
                    <span className="font-doodle font-bold text-doodle-text">{result.expectedConversions}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-doodle-text/60">
                      <DollarSign className="w-3 h-3" /> Gross Revenue
                    </span>
                    <span className="font-doodle font-bold text-doodle-text">
                      ${Math.round(result.expectedRevenue).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-doodle-text/60">
                      <Percent className="w-3 h-3" /> Discount Cost
                    </span>
                    <span className="font-doodle text-doodle-accent">
                      -${Math.round(result.discountCost).toLocaleString()}
                    </span>
                  </div>
                  <div className="pt-2 border-t border-dashed border-doodle-text/20">
                    <div className="flex items-center justify-between">
                      <span className="font-doodle font-bold text-doodle-text">Net Revenue</span>
                      <span className="font-doodle font-bold text-doodle-green text-lg">
                        ${Math.round(result.netRevenue).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Action Button */}
          <div className="text-center pt-4">
            <Button className="doodle-button doodle-button-primary">
              <Mail className="w-4 h-4 mr-2" />
              Launch "{bestScenario.scenario}" Campaign
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RecoveryCampaignSimulator;
