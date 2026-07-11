import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, Clock, HardHat, Activity } from "lucide-react";
import {
  fetchWarehouseWorkforce,
  fetchWarehouseWorkforceDetail,
  type WarehouseWorkerStatus,
} from "@/services/warehouseApi";

const STATUS_COLOURS: Record<string, string> = {
  available: "bg-green-100 text-green-800",
  working: "bg-blue-100 text-blue-800",
  "off-shift": "bg-gray-100 text-gray-800",
  unavailable: "bg-red-100 text-red-800",
};

const WarehouseWorkforce: React.FC = () => {
  const [tab, setTab] = useState("overview");

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["warehouse-workforce"],
    queryFn: fetchWarehouseWorkforce,
    refetchInterval: 5000,
  });

  const { data: workers, isLoading: workersLoading } = useQuery({
    queryKey: ["warehouse-workforce-detail"],
    queryFn: fetchWarehouseWorkforceDetail,
    refetchInterval: 5000,
  });

  const groupedByShift = React.useMemo(() => {
    if (!workers) return new Map<number, WarehouseWorkerStatus[]>();
    const map = new Map<number, WarehouseWorkerStatus[]>();
    workers.forEach((w) => {
      const arr = map.get(w.shiftId) ?? [];
      arr.push(w);
      map.set(w.shiftId, arr);
    });
    return map;
  }, [workers]);

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-doodle flex items-center gap-2">
          <Users className="h-6 w-6 text-doodle-text" /> Warehouse Workforce
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Three-shift warehouse team — Finished Goods Storage (Location 7).
        </p>
      </div>

      {/* Snapshot cards */}
      {snapshotLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="doodle-border-light">
              <CardContent className="p-4">
                <Skeleton className="h-8 w-12 mb-1" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              label: "Total Workers",
              value: snapshot?.totalWorkers ?? 0,
              colour: "text-foreground",
            },
            {
              label: "Working Now",
              value: snapshot?.currentlyWorking ?? 0,
              colour: "text-blue-600",
            },
            {
              label: "Available",
              value: snapshot?.availableNow ?? 0,
              colour: "text-green-600",
            },
            {
              label: "Off Shift",
              value: snapshot?.offShift ?? 0,
              colour: "text-gray-500",
            },
          ].map(({ label, value, colour }) => (
            <Card key={label} className="doodle-border-light">
              <CardContent className="p-4">
                <p className={`text-2xl font-bold ${colour}`}>{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Shift utilisation bars */}
      {snapshot && (
        <Card className="doodle-border-light">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" /> Utilisation by Shift
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.byShift.map((s) => {
              const pct = s.headcount > 0 ? (s.working / s.headcount) * 100 : 0;
              return (
                <div key={s.shiftId}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{s.shiftName} Shift</span>
                    <span className="text-muted-foreground">
                      {s.working} / {s.headcount} working ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <Progress
                    value={pct}
                    className={
                      pct > 90
                        ? "[&>div]:bg-red-500"
                        : pct > 70
                          ? "[&>div]:bg-orange-400"
                          : "[&>div]:bg-green-500"
                    }
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Worker detail tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">
            <Activity className="h-3.5 w-3.5 mr-1.5" />
            By Shift
          </TabsTrigger>
          <TabsTrigger value="all">
            <HardHat className="h-3.5 w-3.5 mr-1.5" />
            All Workers
          </TabsTrigger>
        </TabsList>

        {/* By-shift view */}
        <TabsContent value="overview" className="space-y-4 mt-4">
          {workersLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            Array.from(groupedByShift.entries())
              .sort(([a], [b]) => a - b)
              .map(([shiftId, shiftWorkers]) => {
                const shiftName =
                  shiftWorkers[0]?.shiftName ?? `Shift ${shiftId}`;
                return (
                  <Card key={shiftId} className="doodle-border-light">
                    <CardHeader className="py-3 pb-0">
                      <CardTitle className="text-sm">
                        {shiftName} Shift
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {
                            shiftWorkers.filter((w) => w.status === "working")
                              .length
                          }{" "}
                          working,{" "}
                          {
                            shiftWorkers.filter((w) => w.status === "available")
                              .length
                          }{" "}
                          available
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="py-2">
                      <div className="flex flex-wrap gap-2">
                        {shiftWorkers.map((w) => (
                          <div
                            key={w.employeeId}
                            title={w.currentOperation ?? w.jobTitle}
                            className="flex items-center gap-1.5 text-xs border rounded px-2 py-1 bg-background"
                          >
                            <span
                              className={`inline-block w-2 h-2 rounded-full ${
                                w.status === "working"
                                  ? "bg-blue-500"
                                  : w.status === "available"
                                    ? "bg-green-500"
                                    : w.status === "off-shift"
                                      ? "bg-gray-300"
                                      : "bg-red-400"
                              }`}
                            />
                            {w.name.split(" ")[0]}
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
          )}
        </TabsContent>

        {/* Full worker table */}
        <TabsContent value="all" className="mt-4">
          <Card className="doodle-border-light">
            <CardContent className="p-0">
              {workersLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Job Title</TableHead>
                        <TableHead>Shift</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Current Operation</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Tenure</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(workers ?? []).map((w) => (
                        <TableRow key={w.employeeId}>
                          <TableCell className="font-medium">
                            {w.name}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {w.jobTitle}
                          </TableCell>
                          <TableCell className="text-xs">
                            {w.shiftName}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={`text-xs ${STATUS_COLOURS[w.status] ?? "bg-gray-100 text-gray-800"}`}
                            >
                              {w.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {w.currentOperation ?? "—"}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            ${w.hourlyRate.toFixed(2)}/hr
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {w.tenureYears.toFixed(1)} yr
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default WarehouseWorkforce;
