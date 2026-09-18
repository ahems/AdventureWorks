import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, Truck } from "lucide-react";
import {
  fetchSupplyChainConfig,
  updateSupplyChainConfig,
} from "@/services/supplyChainApi";
import { toast } from "sonner";

/** Simulation time scale factor (must match backend default) */
const SIM_TIME_SCALE = 60;

function calcDeliveryMinutes(leadTimeDays: number, multiplier: number): string {
  const seconds = (leadTimeDays * 24 * 3600) / (SIM_TIME_SCALE * multiplier);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = seconds / 60;
  return mins < 10 ? `${mins.toFixed(1)} min` : `${Math.round(mins)} min`;
}

export function SupplyChainTimingCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["supply-chain-config"],
    queryFn: fetchSupplyChainConfig,
  });

  const [multiplier, setMultiplier] = useState(15);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setMultiplier(data.supplyChainSpeedMultiplier);
      setDirty(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      updateSupplyChainConfig({ supplyChainSpeedMultiplier: multiplier }),
    onSuccess: () => {
      toast.success("Supply chain speed updated");
      qc.invalidateQueries({ queryKey: ["supply-chain-config"] });
      setDirty(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-32 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-doodle flex items-center gap-2">
          <Truck className="h-5 w-5" /> Supply Chain Timing
        </CardTitle>
        <CardDescription>
          <p>
            Controls how fast supplier deliveries and vendor restocking happen
            relative to the simulation clock. Higher values mean faster
            deliveries — useful for keeping manufacturing fed without long waits.
          </p>
          <p className="mt-1 text-xs italic">
            Applied on top of the global simulation time scale (60×). Default
            15× means total effective compression of 900×.
          </p>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Speed Multiplier</label>
            <span className="text-sm font-mono font-bold text-primary">
              {multiplier}×
            </span>
          </div>
          <Slider
            min={1}
            max={50}
            step={1}
            value={[multiplier]}
            onValueChange={([v]) => {
              setMultiplier(v);
              setDirty(true);
            }}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>1× (original speed)</span>
            <span>50× (fastest)</span>
          </div>
        </div>

        {/* Live preview of delivery times */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Estimated real-time delivery
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">1-day vendor:</span>
            <span className="font-mono">
              {calcDeliveryMinutes(1, multiplier)}
            </span>
            <span className="text-muted-foreground">3-day vendor:</span>
            <span className="font-mono">
              {calcDeliveryMinutes(3, multiplier)}
            </span>
            <span className="text-muted-foreground">7-day vendor:</span>
            <span className="font-mono">
              {calcDeliveryMinutes(7, multiplier)}
            </span>
            <span className="text-muted-foreground">14-day vendor:</span>
            <span className="font-mono">
              {calcDeliveryMinutes(14, multiplier)}
            </span>
          </div>
        </div>

        <Button
          onClick={() => mutation.mutate()}
          disabled={!dirty || mutation.isPending}
          className="w-full sm:w-auto"
        >
          <Save className="h-4 w-4 mr-1" />
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default SupplyChainTimingCard;
