import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StopCircle, RefreshCw, Zap, Pause, PlayCircle } from 'lucide-react';
import { fetchManufacturingStatus, stopManufacturing, type ManufacturingStatus } from '@/services/api';
import { resetSupplyChain, initializeSupplyChain } from '@/services/supplyChainApi';
import { toast } from 'sonner';

export function SimulationControlCard() {
  const qc = useQueryClient();
  const { data: status } = useQuery<ManufacturingStatus>({
    queryKey: ['manufacturing-status'],
    queryFn: fetchManufacturingStatus,
    refetchInterval: 5000,
  });
  const isRunning = status?.isRunning ?? false;

  const stopMutation = useMutation({
    mutationFn: stopManufacturing,
    onSuccess: () => {
      toast.success('Production queue cleared — container will scale to zero.');
      qc.invalidateQueries({ queryKey: ['manufacturing-status'] });
    },
    onError: (e: any) => toast.error(`Stop failed: ${e.message}`),
  });

  const resetMutation = useMutation({
    mutationFn: resetSupplyChain,
    onSuccess: () => {
      toast.success('Supply chain reset — stock re-seeded');
      qc.invalidateQueries({ queryKey: ['supply-vendors'] });
      qc.invalidateQueries({ queryKey: ['supply-orders'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const initMutation = useMutation({
    mutationFn: initializeSupplyChain,
    onSuccess: () => {
      toast.success('Supply chain initialized');
      qc.invalidateQueries({ queryKey: ['supply-vendors'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-doodle flex items-center justify-between gap-2">
          <span>Simulation Control</span>
          <Badge variant={isRunning ? 'default' : 'secondary'} className="text-xs gap-1">
            {isRunning ? <><Zap className="h-3 w-3" /> Running</> : <><Pause className="h-3 w-3" /> Idle</>}
          </Badge>
        </CardTitle>
        <CardDescription>Master controls for the underlying manufacturing and supply-chain simulators. These actions affect the demo environment, not real production data.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Stop All */}
        <div className="border rounded-lg p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-doodle font-bold text-sm">Stop All</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Halts every active manufacturing operation on the shop floor immediately. New work orders won't start until the simulation is resumed (e.g. by scheduling a new production run).
              </p>
              <p className="text-xs text-muted-foreground mt-1 italic">Use to pause the demo cleanly before a reset, or to clear a runaway state.</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending || !isRunning}
            >
              <StopCircle className="h-4 w-4 mr-1" /> Stop All
            </Button>
          </div>
        </div>

        {/* Reset Supply Chain */}
        <div className="border rounded-lg p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-doodle font-bold text-sm">Reset Supply Chain</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Wipes vendor inventory and re-seeds every supplier's stock back to its starting quantities. In-flight purchase orders are cleared.
              </p>
              <p className="text-xs text-muted-foreground mt-1 italic">Use when the demo's vendor stock has been depleted or you want a clean slate for a presentation.</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${resetMutation.isPending ? 'animate-spin' : ''}`} /> Reset
            </Button>
          </div>
        </div>

        {/* Initialize */}
        <div className="border rounded-lg p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-doodle font-bold text-sm">Initialize Supply Chain</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Bootstraps the supply-chain simulator from scratch — populates the vendor catalog, lead times, prices, and initial stock. Safe on a fresh environment; usually idempotent.
              </p>
              <p className="text-xs text-muted-foreground mt-1 italic">Use for first-time setup of a new demo backend, or after a deeper backend wipe where Reset alone isn't enough.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => initMutation.mutate()}
              disabled={initMutation.isPending}
            >
              <PlayCircle className={`h-4 w-4 mr-1 ${initMutation.isPending ? 'animate-spin' : ''}`} /> Initialize
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default SimulationControlCard;
