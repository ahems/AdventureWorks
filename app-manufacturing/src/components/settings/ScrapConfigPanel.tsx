import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings2, Save, X } from "lucide-react";
import {
  fetchScrapConfig,
  updateScrapConfig,
  fetchScrapReasons,
  type ScrapConfig,
} from "@/services/api";
import { toast } from "sonner";

export function ScrapConfigPanel() {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["scrap-config"],
    queryFn: fetchScrapConfig,
  });
  const { data: scrapReasons } = useQuery({
    queryKey: ["scrap-reasons"],
    queryFn: fetchScrapReasons,
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [editRate, setEditRate] = useState(0);
  const [editReasonIds, setEditReasonIds] = useState<number[]>([]);
  const [editNote, setEditNote] = useState("");

  const mutation = useMutation({
    mutationFn: ({
      locationId,
      body,
    }: {
      locationId: number;
      body: { failureRatePct: number; scrapReasonIds: number[]; note?: string };
    }) => updateScrapConfig(locationId, body),
    onSuccess: () => {
      toast.success("Scrap configuration updated");
      qc.invalidateQueries({ queryKey: ["scrap-config"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  const startEdit = (cfg: ScrapConfig) => {
    setEditing(cfg.locationId);
    setEditRate(cfg.failureRatePct);
    setEditReasonIds([...cfg.scrapReasonIds]);
    setEditNote(cfg.note || "");
  };

  const toggleReason = (id: number) => {
    setEditReasonIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  };

  if (isLoading)
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-doodle">
          Scrap / Failure Configuration
        </CardTitle>
        <CardDescription>
          <p>
            Per-location controls for how often the simulator generates scrap
            events and which scrap reasons (defective material, machine failure,
            etc.) it attributes them to. Higher rates produce more failed units
            and feed the supplier-quality views.
          </p>
          <p className="mt-1 text-xs">
            Use this to stress-test scrap/rework/supplier-quality dashboards or
            to demo how shop-floor losses affect cost and throughput. Changes
            take effect on the next operation processed.
          </p>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configs?.length ? (
          <p className="text-muted-foreground text-sm text-center py-4">
            No scrap configuration available — start a production run to seed
            defaults.
          </p>
        ) : (
          configs.map((cfg) => {
            const isEditing = editing === cfg.locationId;
            return (
              <div
                key={cfg.locationId}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-doodle font-bold text-sm">
                      {cfg.locationName}
                    </h3>
                    {cfg.note && !isEditing && (
                      <p className="text-xs text-muted-foreground italic">
                        {cfg.note}
                      </p>
                    )}
                  </div>
                  {!isEditing ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(cfg)}
                    >
                      <Settings2 className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  ) : (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        onClick={() =>
                          mutation.mutate({
                            locationId: cfg.locationId,
                            body: {
                              failureRatePct: editRate,
                              scrapReasonIds: editReasonIds,
                              note: editNote || undefined,
                            },
                          })
                        }
                        disabled={mutation.isPending}
                      >
                        <Save className="h-3.5 w-3.5 mr-1" /> Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium">
                          Failure Rate
                        </label>
                        <span className="font-mono text-sm font-bold">
                          {(editRate * 100).toFixed(1)}%
                        </span>
                      </div>
                      <Slider
                        value={[editRate * 100]}
                        onValueChange={([v]) => setEditRate(v / 100)}
                        min={0}
                        max={100}
                        step={0.5}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>0% (no failures)</span>
                        <span>100% (always fails)</span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Scrap Reasons
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {scrapReasons?.map((sr) => {
                          const selected = editReasonIds.includes(
                            sr.ScrapReasonID,
                          );
                          return (
                            <button
                              key={sr.ScrapReasonID}
                              onClick={() => toggleReason(sr.ScrapReasonID)}
                              className={`px-2 py-1 text-xs rounded border transition-colors ${
                                selected
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-secondary/50 text-muted-foreground border-border hover:border-primary/50"
                              }`}
                            >
                              {sr.Name}
                            </button>
                          );
                        })}
                      </div>
                      {editReasonIds.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No reasons selected — scrap chance rolls but no event
                          is recorded.
                        </p>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-medium">Note</label>
                      <Input
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="e.g. Chaos mode — stress testing"
                        className="text-sm"
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground">
                        Failure rate:{" "}
                      </span>
                      <span
                        className={`font-mono font-bold ${cfg.failureRatePct > 0.1 ? "text-destructive" : cfg.failureRatePct > 0 ? "text-[hsl(var(--doodle-accent))]" : "text-[hsl(var(--doodle-green))]"}`}
                      >
                        {(cfg.failureRatePct * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {cfg.scrapReasonIds.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          No scrap reasons
                        </span>
                      ) : (
                        cfg.scrapReasonIds.map((id) => {
                          const reason = scrapReasons?.find(
                            (sr) => sr.ScrapReasonID === id,
                          );
                          return (
                            <Badge
                              key={id}
                              variant="secondary"
                              className="text-xs"
                            >
                              {reason?.Name || `#${id}`}
                            </Badge>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export default ScrapConfigPanel;
