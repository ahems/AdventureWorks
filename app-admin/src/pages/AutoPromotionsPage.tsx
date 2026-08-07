import React from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  ArrowLeft,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Store,
  Sparkles,
  Activity,
  Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import {
  getAutoPromotionConfig,
  updateAutoPromotionConfig,
  resetAutoPromotionCounters,
  type AutoPromotionConfig,
} from "@/services/utilityService";
import { toast } from "@/hooks/use-toast";

const POLL_INTERVAL_MS = 30_000;

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function AutoPromotionsPage() {
  const [config, setConfig] = React.useState<AutoPromotionConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Local editable state (applied on save)
  const [enabled, setEnabled] = React.useState(false);
  const [triggerConsumer, setTriggerConsumer] = React.useState(true);
  const [triggerStore, setTriggerStore] = React.useState(true);
  const [consumerThreshold, setConsumerThreshold] = React.useState(50);
  const [storeThreshold, setStoreThreshold] = React.useState(50);

  const initializedRef = React.useRef(false);

  const fetchConfig = React.useCallback(async () => {
    try {
      const c = await getAutoPromotionConfig();
      setConfig(c);
      // Only sync form fields on first load — don't overwrite in-progress edits
      if (!initializedRef.current) {
        initializedRef.current = true;
        setEnabled(c.isEnabled);
        setTriggerConsumer(c.triggerOnConsumerOrders);
        setTriggerStore(c.triggerOnStoreOrders);
        setConsumerThreshold(c.consumerOrderThreshold);
        setStoreThreshold(c.storeOrderThreshold);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchConfig();
    const id = setInterval(fetchConfig, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateAutoPromotionConfig({
        isEnabled: enabled,
        triggerOnConsumerOrders: triggerConsumer,
        triggerOnStoreOrders: triggerStore,
        consumerOrderThreshold: consumerThreshold,
        storeOrderThreshold: storeThreshold,
      });
      setConfig(updated);
      toast({ title: "Auto-Promotion config saved" });
    } catch (err) {
      toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      await resetAutoPromotionCounters();
      await fetchConfig();
      toast({ title: "Counters reset to zero" });
    } catch (err) {
      toast({
        title: "Failed to reset",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const isDirty =
    config != null &&
    (enabled !== config.isEnabled ||
      triggerConsumer !== config.triggerOnConsumerOrders ||
      triggerStore !== config.triggerOnStoreOrders ||
      consumerThreshold !== config.consumerOrderThreshold ||
      storeThreshold !== config.storeOrderThreshold);

  const canSave = (triggerConsumer || triggerStore) && !saving;

  return (
    <div className="min-h-screen flex flex-col bg-doodle-bg">
      <AdminHeader />
      <main className="flex-1 container mx-auto px-4 py-8 max-w-3xl">
        {/* Page header */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            to="/promotions"
            className="doodle-button p-2 inline-flex items-center"
            title="Back to Promotions"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="doodle-border-light p-2">
            <Bot className="w-7 h-7 text-doodle-text" />
          </div>
          <div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text">
              Auto-Promotions
            </h1>
            <p className="font-doodle text-sm text-doodle-text/60 mt-0.5">
              Automatically generate AI-driven promotions when order volume
              thresholds are reached
            </p>
          </div>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="doodle-button p-1.5"
              onClick={fetchConfig}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 doodle-card border-doodle-accent p-3">
            <p className="font-doodle text-sm text-doodle-accent">{error}</p>
          </div>
        )}

        {/* Configuration card */}
        <Card className="doodle-card mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-doodle font-bold text-doodle-text">
                  Enable Auto-Promotions
                </Label>
                <p className="font-doodle text-xs text-doodle-text/60 mt-0.5">
                  When enabled, promotions are automatically created after
                  reaching order thresholds
                </p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={loading}
              />
            </div>

            {/* Order type toggles */}
            <div className="space-y-3 border-t border-doodle-text/10 pt-4">
              <Label className="font-doodle font-bold text-doodle-text">
                Trigger On
              </Label>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4 text-doodle-text/70" />
                  <span className="font-doodle text-sm text-doodle-text">
                    Consumer (B2C) orders
                  </span>
                  <Badge
                    variant="outline"
                    className="font-doodle text-[10px] py-0 px-1"
                  >
                    Promotional Discount / Clearance
                  </Badge>
                </div>
                <Switch
                  checked={triggerConsumer}
                  onCheckedChange={(v) => {
                    if (!v && !triggerStore) return;
                    setTriggerConsumer(v);
                  }}
                  disabled={loading}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Store className="w-4 h-4 text-doodle-text/70" />
                  <span className="font-doodle text-sm text-doodle-text">
                    B2B store orders
                  </span>
                  <Badge
                    variant="outline"
                    className="font-doodle text-[10px] py-0 px-1"
                  >
                    Volume Discount for Resellers
                  </Badge>
                </div>
                <Switch
                  checked={triggerStore}
                  onCheckedChange={(v) => {
                    if (!v && !triggerConsumer) return;
                    setTriggerStore(v);
                  }}
                  disabled={loading}
                />
              </div>
            </div>

            {/* Consumer threshold slider */}
            {triggerConsumer && (
              <div className="space-y-3 border-t border-doodle-text/10 pt-4">
                <div className="flex justify-between items-baseline">
                  <Label className="font-doodle font-bold text-doodle-text">
                    Consumer Order Threshold
                  </Label>
                  <span className="font-doodle text-sm text-doodle-accent font-semibold">
                    Every {consumerThreshold} orders
                  </span>
                </div>
                <Slider
                  min={10}
                  max={1000}
                  step={10}
                  value={[consumerThreshold]}
                  onValueChange={([v]) => setConsumerThreshold(v)}
                  disabled={loading}
                  className="w-full"
                />
                <div className="flex justify-between">
                  <span className="font-doodle text-xs text-doodle-text/50">
                    10
                  </span>
                  <span className="font-doodle text-xs text-doodle-text/50">
                    1000
                  </span>
                </div>
              </div>
            )}

            {/* Store threshold slider */}
            {triggerStore && (
              <div className="space-y-3 border-t border-doodle-text/10 pt-4">
                <div className="flex justify-between items-baseline">
                  <Label className="font-doodle font-bold text-doodle-text">
                    Store Order Threshold
                  </Label>
                  <span className="font-doodle text-sm text-doodle-accent font-semibold">
                    Every {storeThreshold} orders
                  </span>
                </div>
                <Slider
                  min={10}
                  max={1000}
                  step={10}
                  value={[storeThreshold]}
                  onValueChange={([v]) => setStoreThreshold(v)}
                  disabled={loading}
                  className="w-full"
                />
                <div className="flex justify-between">
                  <span className="font-doodle text-xs text-doodle-text/50">
                    10
                  </span>
                  <span className="font-doodle text-xs text-doodle-text/50">
                    1000
                  </span>
                </div>
              </div>
            )}

            {/* Save button */}
            <div className="pt-2">
              <Button
                onClick={handleSave}
                disabled={!canSave || !isDirty}
                className="doodle-button doodle-button-primary w-full flex items-center gap-2 justify-center py-3"
              >
                {saving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span className="font-doodle font-bold">
                  {saving ? "Saving…" : "Save Configuration"}
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Live stats card */}
        {config && config.isEnabled && (
          <Card className="doodle-card mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
                <Activity className="w-5 h-5" />
                Live Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Counter progress */}
              {config.triggerOnConsumerOrders && (
                <div className="space-y-1">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-sm text-doodle-text">
                      Consumer orders
                    </span>
                    <span className="font-doodle text-sm font-semibold text-doodle-accent">
                      {config.consumerOrderCounter} /{" "}
                      {config.consumerOrderThreshold}
                    </span>
                  </div>
                  <div className="h-2 bg-doodle-text/10 rounded overflow-hidden border border-doodle-text/20">
                    <div
                      className="h-full bg-doodle-green transition-all duration-500"
                      style={{
                        width: `${Math.min(100, (config.consumerOrderCounter / config.consumerOrderThreshold) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="font-doodle text-xs text-doodle-text/50">
                    Last triggered:{" "}
                    {formatTimestamp(config.lastConsumerTriggerAt)}
                  </p>
                </div>
              )}
              {config.triggerOnStoreOrders && (
                <div className="space-y-1">
                  <div className="flex justify-between items-baseline">
                    <span className="font-doodle text-sm text-doodle-text">
                      Store orders
                    </span>
                    <span className="font-doodle text-sm font-semibold text-doodle-accent">
                      {config.storeOrderCounter} / {config.storeOrderThreshold}
                    </span>
                  </div>
                  <div className="h-2 bg-doodle-text/10 rounded overflow-hidden border border-doodle-text/20">
                    <div
                      className="h-full bg-blue-500 transition-all duration-500"
                      style={{
                        width: `${Math.min(100, (config.storeOrderCounter / config.storeOrderThreshold) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="font-doodle text-xs text-doodle-text/50">
                    Last triggered: {formatTimestamp(config.lastStoreTriggerAt)}
                  </p>
                </div>
              )}

              {/* Lifetime stats */}
              <div className="border-t border-doodle-text/10 pt-3 flex items-center justify-between">
                <div>
                  <p className="font-doodle text-sm text-doodle-text">
                    Total auto-promotions created:{" "}
                    <strong>{config.totalAutoPromotionsCreated}</strong>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="doodle-button font-doodle text-xs"
                  onClick={handleReset}
                >
                  <RotateCcw className="w-3 h-3 mr-1" />
                  Reset Counters
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* How it works card */}
        <Card className="doodle-card mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="font-doodle text-lg text-doodle-text flex items-center gap-2">
              <Info className="w-5 h-5" />
              How It Works
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="font-doodle text-sm text-doodle-text/80 space-y-2 list-disc list-inside">
              <li>
                Every time a new order is placed, the system increments a
                counter for that order type (Consumer or B2B Store).
              </li>
              <li>
                When the counter reaches the configured threshold, the AI
                promotion agent is invoked to generate a targeted promotion
                across all products.
              </li>
              <li>
                <strong>Consumer orders</strong> trigger "Promotional Discount"
                or "Clearance" promotions (alternating) for the Customer
                category.
              </li>
              <li>
                <strong>B2B Store orders</strong> trigger "Volume Discount"
                promotions for the Reseller category.
              </li>
              <li>
                The AI agent analyses recent product movement (24 hours to 7
                days) to determine the best products and an appropriate
                promotion duration.
              </li>
              <li>
                After each auto-promotion is created, any existing active
                promotion containing out-of-stock products is automatically
                expired.
              </li>
            </ul>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
