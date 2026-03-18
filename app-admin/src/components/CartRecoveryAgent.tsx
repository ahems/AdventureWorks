import React, { useState } from "react";
import {
  Bot,
  Play,
  Zap,
  TrendingUp,
  Mail,
  Loader2,
  CheckCircle,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import CartRecoveryStrategyCard from "@/components/CartRecoveryStrategyCard";
import RecoveryCampaignSimulator from "@/components/RecoveryCampaignSimulator";
import { StaleCart } from "@/types/shoppingCart";
import { getFunctionsApiUrl } from "@/lib/utils";
import { toast } from "sonner";

interface CartRecoveryAgentProps {
  carts: StaleCart[];
}

interface CartStrategy {
  cart: StaleCart;
  recoveryScore: number;
  urgency: "high" | "medium" | "low";
  strategy: string;
  recommendedDiscount: number;
  emailSubject: string;
  emailPreview: string;
  error?: string;
}

const CartRecoveryAgent: React.FC<CartRecoveryAgentProps> = ({ carts }) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [strategies, setStrategies] = useState<CartStrategy[]>([]);
  const [showSimulator, setShowSimulator] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);

  const runAnalysis = async () => {
    setIsAnalyzing(true);
    setAnalysisProgress(0);
    setStrategies([]);
    setAnalysisComplete(false);

    try {
      const response = await fetch(
        `${getFunctionsApiUrl()}/api/carts/analyze-recovery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            carts: carts.map((c) => ({
              cartId: c.ShoppingCartID,
              customerName: c.customerName,
              totalValue: c.totalValue,
              daysStale: c.daysStale,
              totalItems: c.totalItems,
            })),
          }),
        },
      );

      if (!response.ok) throw new Error(`Analysis failed: ${response.status}`);
      const data = await response.json();

      const cartMap = new Map(carts.map((c) => [c.ShoppingCartID, c]));
      const newStrategies: CartStrategy[] = (data.strategies ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => {
          const cart = cartMap.get(r.cartId);
          if (!cart) return null;
          return {
            cart,
            recoveryScore: r.recoveryScore ?? 0,
            urgency: (["high", "medium", "low"].includes(r.urgency)
              ? r.urgency
              : "low") as "high" | "medium" | "low",
            strategy: r.strategy ?? "",
            recommendedDiscount: r.recommendedDiscount ?? 0,
            emailSubject: r.emailSubject ?? "",
            emailPreview: r.emailBody ?? "",
            error: r.error,
          };
        })
        .filter(Boolean);

      setStrategies(newStrategies);
      setAnalysisProgress(100);
      setAnalysisComplete(true);
    } catch (err) {
      console.error("Cart recovery analysis failed:", err);
      toast.error("Failed to analyze carts. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const sortedStrategies = [...strategies].sort(
    (a, b) => b.recoveryScore - a.recoveryScore,
  );
  const highPriority = strategies.filter((s) => s.urgency === "high");
  const potentialRecovery = strategies.reduce((sum, s) => {
    if (s.urgency === "high") return sum + s.cart.totalValue * 0.35;
    if (s.urgency === "medium") return sum + s.cart.totalValue * 0.15;
    return sum + s.cart.totalValue * 0.05;
  }, 0);

  return (
    <div className="space-y-6">
      {/* Agent Header */}
      <div className="doodle-card p-6 bg-gradient-to-r from-doodle-accent/5 to-doodle-green/5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-doodle-accent to-doodle-green flex items-center justify-center">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="font-doodle text-xl font-bold text-doodle-text flex items-center gap-2">
                AI Cart Recovery Agent
                <span className="text-xs bg-doodle-green/20 text-doodle-green px-2 py-0.5 rounded-full">
                  BETA
                </span>
              </h2>
              <p className="font-doodle text-sm text-doodle-text/60">
                Intelligent analysis and automated recovery strategies
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!isAnalyzing && !analysisComplete && (
              <Button
                onClick={runAnalysis}
                className="doodle-button doodle-button-primary"
              >
                <Zap className="w-4 h-4 mr-2" />
                Analyze All Carts
              </Button>
            )}
            {analysisComplete && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowSimulator(!showSimulator)}
                  className="doodle-button"
                >
                  <BarChart3 className="w-4 h-4 mr-2" />
                  {showSimulator ? "Hide" : "Show"} Simulator
                </Button>
                <Button
                  onClick={runAnalysis}
                  variant="outline"
                  className="doodle-button"
                >
                  <Play className="w-4 h-4 mr-2" />
                  Re-analyze
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Analysis Progress */}
        {isAnalyzing && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="font-doodle text-sm text-doodle-text/70">
                Analyzing {strategies.length} of {carts.length} carts...
              </span>
              <span className="font-doodle text-sm font-bold text-doodle-accent">
                {Math.round(analysisProgress)}%
              </span>
            </div>
            <Progress value={analysisProgress} className="h-2" />
            <div className="flex items-center gap-2 mt-3 text-sm text-doodle-text/60">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="font-doodle">
                Calculating recovery scores and generating strategies...
              </span>
            </div>
          </div>
        )}

        {/* Analysis Summary */}
        {analysisComplete && (
          <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white/50 dark:bg-black/20 rounded-lg p-4 border-2 border-doodle-text/10">
              <p className="font-doodle text-2xl font-bold text-doodle-text">
                {strategies.length}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Carts Analyzed
              </p>
            </div>
            <div className="bg-white/50 dark:bg-black/20 rounded-lg p-4 border-2 border-doodle-text/10">
              <p className="font-doodle text-2xl font-bold text-doodle-green">
                {highPriority.length}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                High Priority
              </p>
            </div>
            <div className="bg-white/50 dark:bg-black/20 rounded-lg p-4 border-2 border-doodle-text/10">
              <p className="font-doodle text-2xl font-bold text-doodle-accent">
                $
                {potentialRecovery.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Est. Recoverable
              </p>
            </div>
            <div className="bg-white/50 dark:bg-black/20 rounded-lg p-4 border-2 border-doodle-text/10">
              <p className="font-doodle text-2xl font-bold text-doodle-blue">
                {Math.round(
                  strategies.reduce((sum, s) => sum + s.recoveryScore, 0) /
                    strategies.length,
                )}
                %
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Avg. Recovery Score
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Campaign Simulator */}
      {showSimulator && analysisComplete && (
        <RecoveryCampaignSimulator strategies={sortedStrategies} />
      )}

      {/* Strategy Cards */}
      {strategies.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-doodle-accent" />
              Recovery Strategies (Sorted by Priority)
            </h3>
            {analysisComplete && (
              <Button variant="outline" size="sm" className="doodle-button">
                <Mail className="w-4 h-4 mr-2" />
                Send All High Priority
              </Button>
            )}
          </div>

          <div className="space-y-4">
            {sortedStrategies.map((strategy) => (
              <CartRecoveryStrategyCard
                key={strategy.cart.ShoppingCartID}
                strategy={strategy}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default CartRecoveryAgent;
