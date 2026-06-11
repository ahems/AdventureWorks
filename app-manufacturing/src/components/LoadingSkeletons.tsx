import { Skeleton } from '@/components/ui/skeleton';

export const TableSkeleton = ({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) => (
  <div className="doodle-card-static overflow-x-auto">
    <table className="w-full">
      <thead>
        <tr className="border-b-2 border-doodle-text/20">
          {Array.from({ length: cols }).map((_, i) => (
            <th key={i} className="py-3 px-4"><Skeleton className="h-4 w-20" /></th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r} className="border-b border-doodle-text/10">
            {Array.from({ length: cols }).map((_, c) => (
              <td key={c} className="py-3 px-4"><Skeleton className="h-4 w-full" /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const CardGridSkeleton = ({ count = 6 }: { count?: number }) => (
  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="doodle-card p-5 space-y-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    ))}
  </div>
);

export const KpiSkeleton = ({ count = 5 }: { count?: number }) => (
  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="doodle-card p-4 flex flex-col items-center gap-2">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-3 w-20" />
      </div>
    ))}
  </div>
);

export const DetailPageSkeleton = () => (
  <div className="space-y-6">
    <div className="doodle-card-static p-6 space-y-4">
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <div className="flex gap-6 mt-4">
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-12 w-24" />
      </div>
    </div>
    <TableSkeleton rows={5} cols={6} />
  </div>
);

export const SidebarListSkeleton = ({ count = 10 }: { count?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: count }).map((_, i) => (
      <Skeleton key={i} className="h-9 w-full rounded" />
    ))}
  </div>
);

export const ChartSkeleton = () => (
  <div className="doodle-card-static p-6 space-y-4">
    <Skeleton className="h-5 w-1/3" />
    <Skeleton className="h-[300px] w-full rounded" />
  </div>
);

export const DashboardSkeleton = () => (
  <div className="space-y-8">
    <div className="doodle-card-static p-6 space-y-2">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
    </div>
    <KpiSkeleton />
    <Skeleton className="h-24 w-full rounded-lg" />
    <div className="grid md:grid-cols-3 gap-6">
      <div className="md:col-span-2">
        <TableSkeleton rows={8} cols={5} />
      </div>
      <div className="doodle-card-static p-6 space-y-3">
        <Skeleton className="h-5 w-1/2" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded" />
        ))}
      </div>
    </div>
  </div>
);

export const ScheduleSkeleton = () => (
  <div className="space-y-6">
    {Array.from({ length: 3 }).map((_, i) => (
      <div key={i} className="doodle-card-static p-4 space-y-3">
        <Skeleton className="h-5 w-1/3" />
        <TableSkeleton rows={4} cols={6} />
      </div>
    ))}
  </div>
);

export const ShopFloorSkeleton = () => (
  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="doodle-card p-5 space-y-3">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full rounded-sm" />
      </div>
    ))}
  </div>
);
