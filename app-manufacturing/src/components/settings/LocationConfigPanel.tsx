import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings2, Save, X } from "lucide-react";
import {
  fetchLocationConfig,
  updateLocationConfig,
  type LocationConfig,
} from "@/services/api";
import { toast } from "sonner";

export function LocationConfigPanel() {
  const qc = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["location-config"],
    queryFn: fetchLocationConfig,
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [editCapacity, setEditCapacity] = useState(1);
  const [editHours, setEditHours] = useState(8);
  const [editSpeed, setEditSpeed] = useState(1);
  const [editOvertime, setEditOvertime] = useState(1.5);
  const [editShiftStart, setEditShiftStart] = useState(6);
  const [editNote, setEditNote] = useState("");

  const mutation = useMutation({
    mutationFn: ({
      locationId,
      body,
    }: {
      locationId: number;
      body: Record<string, unknown>;
    }) => updateLocationConfig(locationId, body),
    onSuccess: () => {
      toast.success("Location configuration updated");
      qc.invalidateQueries({ queryKey: ["location-config"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  const startEdit = (cfg: LocationConfig) => {
    setEditing(cfg.locationId);
    setEditCapacity(cfg.capacityUnits);
    setEditHours(cfg.dailyOperatingHours);
    setEditSpeed(cfg.speedFactor);
    setEditOvertime(cfg.overtimeMultiplier);
    setEditShiftStart(cfg.shiftStartHour);
    setEditNote(cfg.note || "");
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
          Location Capacity Configuration
        </CardTitle>
        <CardDescription>
          <p>
            Sets the maximum concurrent operations each manufacturing location
            can run, plus shift hours and speed factor. The simulator queues
            work orders when a location is full.
          </p>
          <p className="mt-1 text-xs">
            Use this to create bottlenecks for demos (e.g. show subassembly
            stalling final assembly) or to widen capacity when running large
            simulated batches. Changes take effect immediately.
          </p>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configs?.length ? (
          <p className="text-muted-foreground text-sm text-center py-4">
            No location configuration available — start a production run to seed
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
                              capacityUnits: editCapacity,
                              dailyOperatingHours: editHours,
                              speedFactor: editSpeed,
                              overtimeMultiplier: editOvertime,
                              shiftStartHour: editShiftStart,
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
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Capacity Units (parallel slots)
                      </label>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[editCapacity]}
                          onValueChange={([v]) => setEditCapacity(v)}
                          min={1}
                          max={10}
                          step={1}
                          className="flex-1"
                        />
                        <span className="font-mono text-sm font-bold w-8 text-right">
                          {editCapacity}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        More slots = more parallel work orders at this station
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Daily Operating Hours
                      </label>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[editHours]}
                          onValueChange={([v]) => setEditHours(v)}
                          min={1}
                          max={24}
                          step={0.5}
                          className="flex-1"
                        />
                        <span className="font-mono text-sm font-bold w-12 text-right">
                          {editHours}h
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Speed Factor
                      </label>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[editSpeed * 10]}
                          onValueChange={([v]) => setEditSpeed(v / 10)}
                          min={1}
                          max={50}
                          step={1}
                          className="flex-1"
                        />
                        <span className="font-mono text-sm font-bold w-12 text-right">
                          {editSpeed.toFixed(1)}×
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        2.0× = ops complete in half the time
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Overtime Multiplier
                      </label>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[editOvertime * 10]}
                          onValueChange={([v]) => setEditOvertime(v / 10)}
                          min={10}
                          max={30}
                          step={1}
                          className="flex-1"
                        />
                        <span className="font-mono text-sm font-bold w-12 text-right">
                          {editOvertime.toFixed(1)}×
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Shift Start Hour (UTC)
                      </label>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[editShiftStart]}
                          onValueChange={([v]) => setEditShiftStart(v)}
                          min={0}
                          max={23}
                          step={1}
                          className="flex-1"
                        />
                        <span className="font-mono text-sm font-bold w-12 text-right">
                          {editShiftStart}:00
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-medium">Note</label>
                      <Input
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="e.g. Added extra machine"
                        className="text-sm"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground text-xs block">
                        Capacity
                      </span>
                      <span className="font-mono font-bold">
                        {cfg.capacityUnits} slot
                        {cfg.capacityUnits !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">
                        Hours/Day
                      </span>
                      <span className="font-mono font-bold">
                        {cfg.dailyOperatingHours}h
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">
                        Speed
                      </span>
                      <span className="font-mono font-bold">
                        {cfg.speedFactor.toFixed(1)}×
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">
                        Overtime
                      </span>
                      <span className="font-mono font-bold">
                        {cfg.overtimeMultiplier.toFixed(1)}×
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">
                        Shift Start
                      </span>
                      <span className="font-mono font-bold">
                        {cfg.shiftStartHour}:00 UTC
                      </span>
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

export default LocationConfigPanel;
