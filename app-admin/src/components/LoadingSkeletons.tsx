import { Skeleton } from "@/components/ui/skeleton";

export const TableSkeleton = ({
  rows = 8,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) => (
  <div className="doodle-card overflow-hidden animate-pulse">
    <div className="flex gap-4 px-4 py-3 border-b-2 border-doodle-text/10">
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="flex-1">
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
    {Array.from({ length: rows }).map((_, r) => (
      <div
        key={r}
        className="flex gap-4 px-4 py-3 border-b border-doodle-text/5"
      >
        {Array.from({ length: cols }).map((_, c) => (
          <div key={c} className="flex-1">
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    ))}
  </div>
);

export const CardGridSkeleton = ({ count = 6 }: { count?: number }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="doodle-card p-5 space-y-3 animate-pulse">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-6 w-16 rounded" />
          <Skeleton className="h-6 w-20 rounded" />
        </div>
      </div>
    ))}
  </div>
);

export const KpiSkeleton = ({ count = 4 }: { count?: number }) => (
  <div
    className={`grid grid-cols-2 ${count > 4 ? "lg:grid-cols-5" : "lg:grid-cols-4"} gap-4 md:gap-6`}
  >
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="doodle-card p-4 md:p-6 animate-pulse">
        <div className="flex items-center justify-between mb-3">
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <Skeleton className="h-9 w-16 mb-2" />
        <Skeleton className="h-3 w-24" />
      </div>
    ))}
  </div>
);

export const ChartSkeleton = () => (
  <div className="doodle-card p-6 space-y-4 animate-pulse">
    <Skeleton className="h-5 w-1/3" />
    <Skeleton className="h-64 w-full rounded" />
  </div>
);

export const ListSkeleton = ({ count = 5 }: { count?: number }) => (
  <div className="space-y-3">
    {Array.from({ length: count }).map((_, i) => (
      <div
        key={i}
        className="flex items-center justify-between p-3 border-2 border-doodle-text/10 animate-pulse"
      >
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
        <Skeleton className="h-6 w-16" />
      </div>
    ))}
  </div>
);
