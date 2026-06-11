import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Users, HardHat, Clock, AlertCircle, Activity, MapPin, ChevronRight } from 'lucide-react';
import { fetchWorkforce, fetchWorkforceDetail, type WorkforceSnapshot, type WorkerStatus } from '@/services/planningApi';
import { fetchActiveOperations, type ActiveOperation } from '@/services/api';
import LocationCapabilityPanel from '@/components/workforce/LocationCapabilityPanel';

const statusColors: Record<string, string> = {
  'available': 'bg-green-100 text-green-800',
  'working': 'bg-blue-100 text-blue-800',
  'off-shift': 'bg-gray-100 text-gray-800',
  'unavailable': 'bg-red-100 text-red-800',
};

const WorkforcePage: React.FC = () => {
  const [tab, setTab] = useState('overview');

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ['workforce'],
    queryFn: fetchWorkforce,
    refetchInterval: 5000,
  });

  const { data: workers, isLoading: workersLoading } = useQuery({
    queryKey: ['workforce-detail'],
    queryFn: fetchWorkforceDetail,
    refetchInterval: 5000,
  });

  const { data: activeOps } = useQuery({
    queryKey: ['active-operations'],
    queryFn: fetchActiveOperations,
    refetchInterval: 5000,
  });

  const workersWithLiveAssignments = useMemo(() => {
    if (!workers) return [] as WorkerStatus[];
    if (!activeOps?.length) return workers;

    const opsByLocation = new Map<number, ActiveOperation[]>();
    activeOps.forEach((op) => {
      const existing = opsByLocation.get(op.locationId) || [];
      existing.push(op);
      opsByLocation.set(op.locationId, existing);
    });

    return workers.map((worker) => {
      if (worker.status !== 'available') return worker;
      const remainingOps = opsByLocation.get(worker.locationId);
      if (!remainingOps?.length) return worker;

      const op = remainingOps.shift()!;
      return {
        ...worker,
        status: 'working',
        currentWorkOrderId: op.workOrderId,
        currentOperation: `${op.productName} · Op ${op.operationSequence}`,
      } satisfies WorkerStatus;
    });
  }, [workers, activeOps]);

  const derivedSnapshot = useMemo(() => {
    if (!snapshot) return null as WorkforceSnapshot | null;
    if (!workersWithLiveAssignments.length) return snapshot;

    const byLocation = new Map<number, WorkforceSnapshot['byLocation'][number]>();

    workersWithLiveAssignments.forEach((worker) => {
      const existing = byLocation.get(worker.locationId) || {
        locationId: worker.locationId,
        locationName: worker.locationName,
        headcount: 0,
        available: 0,
        working: 0,
        offShift: 0,
      };

      existing.headcount += 1;
      if (worker.status === 'available') existing.available += 1;
      if (worker.status === 'working') existing.working += 1;
      if (worker.status === 'off-shift') existing.offShift += 1;

      byLocation.set(worker.locationId, existing);
    });

    return {
      ...snapshot,
      currentlyWorking: workersWithLiveAssignments.filter((w) => w.status === 'working').length,
      availableNow: workersWithLiveAssignments.filter((w) => w.status === 'available').length,
      offShift: workersWithLiveAssignments.filter((w) => w.status === 'off-shift').length,
      unavailable: workersWithLiveAssignments.filter((w) => w.status === 'unavailable').length,
      byLocation: snapshot.byLocation.map((loc) => byLocation.get(loc.locationId) || loc),
    } satisfies WorkforceSnapshot;
  }, [snapshot, workersWithLiveAssignments]);

  // Group workers by location for the expandable view
  const workersByLocation = useMemo(() => {
    const map = new Map<number, WorkerStatus[]>();
    const list = workersWithLiveAssignments.length ? workersWithLiveAssignments : workers || [];
    list.forEach((w) => {
      const existing = map.get(w.locationId) || [];
      existing.push(w);
      map.set(w.locationId, existing);
    });
    // Sort workers within each location: working first, then available, then off-shift
    const statusOrder: Record<string, number> = { working: 0, available: 1, 'off-shift': 2, unavailable: 3 };
    map.forEach((wList) => wList.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)));
    return map;
  }, [workersWithLiveAssignments, workers]);

  const displaySnapshot = derivedSnapshot || snapshot;
  const displayWorkers = workersWithLiveAssignments.length ? workersWithLiveAssignments : workers;
  const usingLiveFallback = Boolean(activeOps?.length && snapshot?.currentlyWorking === 0);

  const renderWoLink = (w: WorkerStatus) => {
    if (!w.currentWorkOrderId) {
      return <span className="text-muted-foreground italic">Idle</span>;
    }
    return (
      <Link
        to={`/plan/work-orders/${w.currentWorkOrderId}`}
        className="text-primary hover:underline font-medium"
      >
        WO #{w.currentWorkOrderId}
        {w.currentOperation && <span className="text-muted-foreground font-normal"> · {w.currentOperation}</span>}
      </Link>
    );
  };

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <Users className="h-7 w-7 text-primary" /> Workforce
        </h1>
        <p className="text-muted-foreground text-sm mt-1">185 manufacturing employees across 7 production stations — shift-aware availability</p>
      </div>

      {usingLiveFallback && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4 flex items-start gap-3">
            <Activity className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <p className="font-doodle text-sm font-bold text-foreground">Live manufacturing fallback active</p>
              <p className="text-xs text-muted-foreground">
                The workforce API is still reporting everyone as available, so this page is using active operations to show current work assignments.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {snapshotLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : displaySnapshot && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <p className="text-2xl font-bold font-doodle">{displaySnapshot.totalActiveWorkers}</p>
                <p className="text-xs text-muted-foreground">Total Workers</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <HardHat className="h-5 w-5 text-[hsl(var(--doodle-blue))]" />
              <div>
                <p className="text-2xl font-bold font-doodle">{displaySnapshot.currentlyWorking}</p>
                <p className="text-xs text-muted-foreground">Working Now</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Clock className="h-5 w-5 text-[hsl(var(--doodle-green))]" />
              <div>
                <p className="text-2xl font-bold font-doodle">{displaySnapshot.availableNow}</p>
                <p className="text-xs text-muted-foreground">Available</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold font-doodle">{displaySnapshot.offShift}</p>
                <p className="text-xs text-muted-foreground">Off Shift</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">By Location</TabsTrigger>
          <TabsTrigger value="roster">Full Roster</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {snapshotLoading ? (
            <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>
          ) : (
            <Accordion type="multiple" className="space-y-3">
              {displaySnapshot?.byLocation.map((loc) => {
                const utilPct = loc.headcount > 0 ? Math.round((loc.working / loc.headcount) * 100) : 0;
                const locationWorkers = workersByLocation.get(loc.locationId) || [];
                const workingWorkers = locationWorkers.filter(w => w.status === 'working');
                const idleWorkers = locationWorkers.filter(w => w.status === 'available');

                return (
                  <AccordionItem key={loc.locationId} value={String(loc.locationId)} className="border rounded-lg">
                    <AccordionTrigger className="hover:no-underline px-4 py-3">
                      <div className="flex items-center gap-3 w-full">
                        <MapPin className="h-4 w-4 text-primary shrink-0" />
                        <div className="flex-1 text-left">
                          <div className="flex items-center gap-2">
                            <span className="font-doodle font-bold">{loc.locationName}</span>
                            <span className="text-xs text-muted-foreground">{loc.headcount} workers</span>
                            {loc.working > 0 && (
                              <Badge className="bg-blue-100 text-blue-800 text-xs">
                                {loc.working} active
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Progress value={utilPct} className="h-2 flex-1 max-w-[200px]" />
                            <span className="text-xs text-muted-foreground">{utilPct}%</span>
                          </div>
                        </div>
                        <div className="flex gap-3 text-xs mr-4">
                          <span className="text-green-600">{loc.available} avail</span>
                          <span className="text-blue-600">{loc.working} working</span>
                          <span className="text-muted-foreground">{loc.offShift} off</span>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-4">
                      {locationWorkers.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">No workers assigned to this location</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Employee</TableHead>
                              <TableHead>Title</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Current Work Order</TableHead>
                              <TableHead className="text-right">Rate/hr</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {locationWorkers.map((w) => (
                              <TableRow key={w.employeeId} className={w.status === 'working' ? 'bg-blue-50/50' : ''}>
                                <TableCell className="font-medium">{w.name}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{w.jobTitle}</TableCell>
                                <TableCell>
                                  <Badge className={`${statusColors[w.status] || ''} text-xs`}>{w.status}</Badge>
                                </TableCell>
                                <TableCell className="text-sm">
                                  {renderWoLink(w)}
                                </TableCell>
                                <TableCell className="text-right font-mono">${w.hourlyRate.toFixed(2)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                      {workingWorkers.length > 0 && (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-xs text-muted-foreground font-medium mb-1">Active Work Orders at {loc.locationName}:</p>
                          <div className="flex flex-wrap gap-2">
                            {[...new Set(workingWorkers.filter(w => w.currentWorkOrderId).map(w => w.currentWorkOrderId))].map(woId => {
                              const worker = workingWorkers.find(w => w.currentWorkOrderId === woId);
                              return (
                                <Link key={woId} to={`/plan/work-orders/${woId}`}>
                                  <Badge variant="outline" className="text-xs hover:bg-primary/10 cursor-pointer gap-1">
                                    WO #{woId}
                                    {worker?.currentOperation && <span className="text-muted-foreground">· {worker.currentOperation}</span>}
                                    <ChevronRight className="h-3 w-3" />
                                  </Badge>
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <LocationCapabilityPanel locationId={loc.locationId} locationName={loc.locationName} />
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </TabsContent>

        <TabsContent value="roster">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">Employee Roster</CardTitle>
              <CardDescription>All manufacturing employees sorted by location, shift, and tenure</CardDescription>
            </CardHeader>
            <CardContent>
              {workersLoading ? (
                <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Shift</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Current Work</TableHead>
                      <TableHead className="text-right">Rate/hr</TableHead>
                      <TableHead className="text-right">Tenure</TableHead>
                      <TableHead className="text-right">Scrap ×</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayWorkers?.map((w) => (
                      <TableRow key={w.employeeId}>
                        <TableCell className="font-medium">{w.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{w.jobTitle}</TableCell>
                        <TableCell className="text-sm">{w.locationName}</TableCell>
                        <TableCell className="text-sm">{w.shiftName}</TableCell>
                        <TableCell>
                          <Badge className={`${statusColors[w.status] || ''} text-xs`}>{w.status}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {renderWoLink(w)}
                        </TableCell>
                        <TableCell className="text-right font-mono">${w.hourlyRate.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{w.tenureYears.toFixed(1)}y</TableCell>
                        <TableCell className="text-right font-mono">{w.scrapRateMultiplier.toFixed(2)}×</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default WorkforcePage;
