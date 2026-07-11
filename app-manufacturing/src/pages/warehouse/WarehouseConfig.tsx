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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Settings2,
  Save,
  X,
  AlertTriangle,
  Truck,
  PackagePlus,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchSubcategoryConfigs,
  updateSubcategoryConfig,
  fetchSupplierReceiveConfigs,
  updateSupplierReceiveConfig,
  fetchDamageConfigs,
  updateDamageConfig,
  fetchWarehouseDamageEvents,
  DAMAGE_REASON_NAMES,
  OP_TYPE_LABELS,
  type SubcategoryHandlingConfig,
  type SupplierReceiveConfig,
  type WarehouseDamageConfig,
} from "@/services/warehouseApi";

// ── Subcategory Config Panel ─────────────────────────────────────────────────

const SubcategoryConfigPanel: React.FC = () => {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["subcategory-configs"],
    queryFn: fetchSubcategoryConfigs,
  });

  const [editing, setEditing] = useState<number | null>(null);
  const [editState, setEditState] = useState<
    Partial<SubcategoryHandlingConfig>
  >({});

  const mutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof updateSubcategoryConfig>[1];
    }) => updateSubcategoryConfig(id, body),
    onSuccess: () => {
      toast.success("Subcategory timing updated");
      qc.invalidateQueries({ queryKey: ["subcategory-configs"] });
      setEditing(null);
    },
    onError: () => toast.error("Update failed"),
  });

  const startEdit = (cfg: SubcategoryHandlingConfig) => {
    setEditing(cfg.subcategoryId);
    setEditState({ ...cfg });
  };

  return (
    <div className="space-y-2">
      {isLoading
        ? Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))
        : (configs ?? []).map((cfg) =>
            editing === cfg.subcategoryId ? (
              <Card key={cfg.subcategoryId} className="border-doodle-blue/40">
                <CardContent className="p-4 space-y-4">
                  <p className="font-medium">{cfg.subcategoryName}</p>

                  <div className="grid grid-cols-2 gap-4">
                    {(
                      [
                        ["Store Min (min)", "storeMinMinutes"],
                        ["Store Max (min)", "storeMaxMinutes"],
                        ["Retrieve Min (min)", "retrieveMinMinutes"],
                        ["Retrieve Max (min)", "retrieveMaxMinutes"],
                      ] as [string, keyof SubcategoryHandlingConfig][]
                    ).map(([label, field]) => (
                      <div key={field}>
                        <label className="text-xs text-muted-foreground">
                          {label}
                        </label>
                        <Input
                          type="number"
                          min={1}
                          value={Number(editState[field] ?? 0)}
                          onChange={(e) =>
                            setEditState((s) => ({
                              ...s,
                              [field]: Number(e.target.value),
                            }))
                          }
                          className="mt-1 h-8 text-sm"
                        />
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">
                      Base weight threshold (kg) — above this, times are scaled
                      up
                    </label>
                    <Input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={Number(editState.baseWeightKgThreshold ?? 5)}
                      onChange={(e) =>
                        setEditState((s) => ({
                          ...s,
                          baseWeightKgThreshold: Number(e.target.value),
                        }))
                      }
                      className="mt-1 h-8 text-sm"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">
                      Note (optional)
                    </label>
                    <Input
                      value={editState.note ?? ""}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, note: e.target.value }))
                      }
                      className="mt-1 h-8 text-sm"
                    />
                  </div>

                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          id: cfg.subcategoryId,
                          body: {
                            storeMinMinutes: Number(editState.storeMinMinutes),
                            storeMaxMinutes: Number(editState.storeMaxMinutes),
                            retrieveMinMinutes: Number(
                              editState.retrieveMinMinutes,
                            ),
                            retrieveMaxMinutes: Number(
                              editState.retrieveMaxMinutes,
                            ),
                            baseWeightKgThreshold: Number(
                              editState.baseWeightKgThreshold ?? 5,
                            ),
                            note: editState.note ?? undefined,
                          },
                        })
                      }
                    >
                      <Save className="h-3.5 w-3.5 mr-1" /> Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div
                key={cfg.subcategoryId}
                className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{cfg.subcategoryName}</p>
                  <p className="text-xs text-muted-foreground">
                    Store: {cfg.storeMinMinutes}–{cfg.storeMaxMinutes} min ·
                    Retrieve: {cfg.retrieveMinMinutes}–{cfg.retrieveMaxMinutes}{" "}
                    min · Weight threshold: {cfg.baseWeightKgThreshold} kg
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startEdit(cfg)}
                >
                  Edit
                </Button>
              </div>
            ),
          )}
    </div>
  );
};

// ── Supplier Receive Config Panel ────────────────────────────────────────────

const SupplierReceiveConfigPanel: React.FC = () => {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["supplier-receive-configs"],
    queryFn: fetchSupplierReceiveConfigs,
  });

  const [editing, setEditing] = useState<number | null>(null);
  const [editState, setEditState] = useState<Partial<SupplierReceiveConfig>>(
    {},
  );

  const mutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof updateSupplierReceiveConfig>[1];
    }) => updateSupplierReceiveConfig(id, body),
    onSuccess: () => {
      toast.success("Supplier receive timing updated");
      qc.invalidateQueries({ queryKey: ["supplier-receive-configs"] });
      setEditing(null);
    },
    onError: () => toast.error("Update failed"),
  });

  const startEdit = (cfg: SupplierReceiveConfig) => {
    setEditing(cfg.subcategoryId);
    setEditState({ ...cfg });
  };

  return (
    <div className="space-y-2">
      {isLoading
        ? Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))
        : (configs ?? []).map((cfg) =>
            editing === cfg.subcategoryId ? (
              <Card key={cfg.subcategoryId} className="border-doodle-blue/40">
                <CardContent className="p-4 space-y-4">
                  <p className="font-medium">{cfg.subcategoryName}</p>
                  <div className="grid grid-cols-2 gap-4">
                    {(
                      [
                        ["Receive Min (min)", "receiveMinMinutes"],
                        ["Receive Max (min)", "receiveMaxMinutes"],
                        ["Inspection Min (min)", "inspectionMinMinutes"],
                        ["Inspection Max (min)", "inspectionMaxMinutes"],
                      ] as [string, keyof SupplierReceiveConfig][]
                    ).map(([label, field]) => (
                      <div key={field}>
                        <label className="text-xs text-muted-foreground">
                          {label}
                        </label>
                        <Input
                          type="number"
                          min={1}
                          value={Number(editState[field] ?? 0)}
                          onChange={(e) =>
                            setEditState((s) => ({
                              ...s,
                              [field]: Number(e.target.value),
                            }))
                          }
                          className="mt-1 h-8 text-sm"
                        />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Additional minutes per unit above base quantity
                    </label>
                    <Input
                      type="number"
                      min={0}
                      step={0.1}
                      value={Number(editState.additionalMinutesPerUnit ?? 0)}
                      onChange={(e) =>
                        setEditState((s) => ({
                          ...s,
                          additionalMinutesPerUnit: Number(e.target.value),
                        }))
                      }
                      className="mt-1 h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Note (optional)
                    </label>
                    <Input
                      value={editState.note ?? ""}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, note: e.target.value }))
                      }
                      className="mt-1 h-8 text-sm"
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          id: cfg.subcategoryId,
                          body: {
                            receiveMinMinutes: Number(
                              editState.receiveMinMinutes,
                            ),
                            receiveMaxMinutes: Number(
                              editState.receiveMaxMinutes,
                            ),
                            inspectionMinMinutes: Number(
                              editState.inspectionMinMinutes,
                            ),
                            inspectionMaxMinutes: Number(
                              editState.inspectionMaxMinutes,
                            ),
                            additionalMinutesPerUnit: Number(
                              editState.additionalMinutesPerUnit ?? 0,
                            ),
                            note: editState.note ?? undefined,
                          },
                        })
                      }
                    >
                      <Save className="h-3.5 w-3.5 mr-1" /> Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div
                key={cfg.subcategoryId}
                className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{cfg.subcategoryName}</p>
                  <p className="text-xs text-muted-foreground">
                    Receive: {cfg.receiveMinMinutes}–{cfg.receiveMaxMinutes} min
                    · Inspect: {cfg.inspectionMinMinutes}–
                    {cfg.inspectionMaxMinutes} min · +
                    {cfg.additionalMinutesPerUnit} min/unit
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startEdit(cfg)}
                >
                  Edit
                </Button>
              </div>
            ),
          )}
    </div>
  );
};

// ── Damage Config Panel ──────────────────────────────────────────────────────

const DamageConfigPanel: React.FC = () => {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["warehouse-damage-config"],
    queryFn: fetchDamageConfigs,
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [editRate, setEditRate] = useState(0);
  const [editReasonIds, setEditReasonIds] = useState<number[]>([]);
  const [editNote, setEditNote] = useState("");

  const mutation = useMutation({
    mutationFn: ({
      operationType,
      body,
    }: {
      operationType: string;
      body: Parameters<typeof updateDamageConfig>[1];
    }) => updateDamageConfig(operationType, body),
    onSuccess: () => {
      toast.success("Damage configuration updated");
      qc.invalidateQueries({ queryKey: ["warehouse-damage-config"] });
      setEditing(null);
    },
    onError: () => toast.error("Update failed"),
  });

  const startEdit = (cfg: WarehouseDamageConfig) => {
    setEditing(cfg.operationType);
    setEditRate(cfg.damageRatePct);
    setEditReasonIds([...cfg.damageReasonIds]);
    setEditNote(cfg.note ?? "");
  };

  const toggleReason = (id: number) =>
    setEditReasonIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );

  const rateColour = (pct: number) =>
    pct === 0
      ? "bg-green-100 text-green-800"
      : pct < 0.05
        ? "bg-yellow-100 text-yellow-800"
        : pct < 0.1
          ? "bg-orange-100 text-orange-800"
          : "bg-red-100 text-red-800";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Configure the probability of an item being damaged during each operation
        type, and which damage reasons apply. Damaged items are written off at
        standard cost.
      </p>
      {isLoading
        ? Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))
        : (configs ?? []).map((cfg) =>
            editing === cfg.operationType ? (
              <Card key={cfg.operationType} className="border-orange-300/60">
                <CardContent className="p-4 space-y-4">
                  <p className="font-medium">
                    {OP_TYPE_LABELS[cfg.operationType] ?? cfg.operationType}
                  </p>

                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <label>Damage rate</label>
                      <span className="font-semibold">
                        {(editRate * 100).toFixed(1)}%
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={100}
                      step={0.5}
                      value={[editRate * 100]}
                      onValueChange={([v]) => setEditRate(v / 100)}
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium">
                      Applicable damage reasons
                    </label>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(DAMAGE_REASON_NAMES).map(
                        ([idStr, name]) => {
                          const id = Number(idStr);
                          const active = editReasonIds.includes(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => toggleReason(id)}
                              className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                                active
                                  ? "bg-orange-100 border-orange-400 text-orange-800"
                                  : "bg-background border-border text-muted-foreground hover:border-orange-300"
                              }`}
                            >
                              {name}
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">
                      Note (optional)
                    </label>
                    <Input
                      value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      className="mt-1 h-8 text-sm"
                    />
                  </div>

                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          operationType: cfg.operationType,
                          body: {
                            damageRatePct: editRate,
                            damageReasonIds: editReasonIds,
                            note: editNote || undefined,
                          },
                        })
                      }
                    >
                      <Save className="h-3.5 w-3.5 mr-1" /> Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div
                key={cfg.operationType}
                className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {OP_TYPE_LABELS[cfg.operationType] ?? cfg.operationType}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {cfg.damageReasonIds.map((id) => (
                      <Badge key={id} variant="outline" className="text-xs">
                        {DAMAGE_REASON_NAMES[id] ?? `Reason ${id}`}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Badge
                  className={`text-xs shrink-0 ${rateColour(cfg.damageRatePct)}`}
                >
                  {(cfg.damageRatePct * 100).toFixed(1)}%
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startEdit(cfg)}
                >
                  Edit
                </Button>
              </div>
            ),
          )}
    </div>
  );
};

// ── Damage Event Log ─────────────────────────────────────────────────────────

const DamageEventLog: React.FC = () => {
  const { data: events, isLoading } = useQuery({
    queryKey: ["warehouse-damage-events"],
    queryFn: () => fetchWarehouseDamageEvents(),
    refetchInterval: 10000,
  });

  return (
    <div className="space-y-2">
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !events || events.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No damage events recorded.
        </p>
      ) : (
        events.slice(0, 20).map((ev) => (
          <div
            key={ev.operationId}
            className="flex items-start gap-3 p-3 border rounded-lg"
          >
            <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{ev.productName}</p>
              <p className="text-xs text-muted-foreground">
                {ev.damagedUnits} damaged · {ev.damageReasonName} ·{" "}
                {ev.operationType}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p
                className={`text-xs font-medium ${ev.isTotalLoss ? "text-red-600" : "text-orange-600"}`}
              >
                ${ev.writeOffValue.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(ev.occurredAtUtc).toLocaleString()}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

// ── Main Page ────────────────────────────────────────────────────────────────

const WarehouseConfig: React.FC = () => (
  <div className="container mx-auto p-4 md:p-6 space-y-6">
    <div>
      <h1 className="text-2xl font-bold font-doodle flex items-center gap-2">
        <Settings2 className="h-6 w-6 text-doodle-text" /> Warehouse
        Configuration
      </h1>
      <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
        Tune operation timing defaults and damage rates. Changes take effect
        immediately — no restart required.
      </p>
    </div>

    <Tabs defaultValue="handling">
      <TabsList>
        <TabsTrigger value="handling">
          <PackagePlus className="h-3.5 w-3.5 mr-1.5" />
          Handling Times
        </TabsTrigger>
        <TabsTrigger value="supplier">
          <Truck className="h-3.5 w-3.5 mr-1.5" />
          Supplier Receive
        </TabsTrigger>
        <TabsTrigger value="damage">
          <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
          Damage Rates
        </TabsTrigger>
        <TabsTrigger value="events">
          <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
          Damage Log
        </TabsTrigger>
      </TabsList>

      <TabsContent value="handling" className="mt-4">
        <Card className="doodle-border-light">
          <CardHeader>
            <CardTitle className="text-base">
              Finished Goods — Store &amp; Retrieve Times
            </CardTitle>
            <CardDescription>
              Min/max minutes per subcategory. Actual duration is randomly
              sampled between min and max, then scaled by item weight if above
              the threshold.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SubcategoryConfigPanel />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="supplier" className="mt-4">
        <Card className="doodle-border-light">
          <CardHeader>
            <CardTitle className="text-base">
              Supplier Deliveries — Receive &amp; Inspection Times
            </CardTitle>
            <CardDescription>
              Per-subcategory durations for unpacking, inspecting, and binning
              incoming supplier goods. A per-unit multiplier reflects that
              larger POs take proportionally longer to process.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SupplierReceiveConfigPanel />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="damage" className="mt-4">
        <Card className="doodle-border-light">
          <CardHeader>
            <CardTitle className="text-base">
              Damage &amp; Incident Rates
            </CardTitle>
            <CardDescription>
              Probability that an item is damaged during each operation type.
              Damaged units are written off at standard cost and recorded in the
              damage log.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DamageConfigPanel />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="events" className="mt-4">
        <Card className="doodle-border-light">
          <CardHeader>
            <CardTitle className="text-base">Damage Event Log</CardTitle>
            <CardDescription>Most recent 20 damage incidents.</CardDescription>
          </CardHeader>
          <CardContent>
            <DamageEventLog />
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  </div>
);

export default WarehouseConfig;
