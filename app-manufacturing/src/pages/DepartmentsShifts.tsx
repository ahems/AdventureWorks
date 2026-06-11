import { useQuery } from '@tanstack/react-query';
import { fetchDepartments, fetchShifts } from '@/services/api';
import { CardGridSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';
import { useMemo } from 'react';

const DepartmentsShifts = () => {
  const { data: departments, isLoading: deptLoading } = useQuery({ queryKey: ['departments'], queryFn: fetchDepartments });
  const { data: shifts, isLoading: shiftLoading } = useQuery({ queryKey: ['shifts'], queryFn: fetchShifts });

  const grouped = useMemo(() => {
    const map = new Map<string, typeof departments>();
    departments?.forEach(d => {
      const list = map.get(d.GroupName) || [];
      list.push(d);
      map.set(d.GroupName, list);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [departments]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-8">
      <h1 className="font-doodle text-2xl font-bold text-doodle-text">Departments & Shifts</h1>

      {/* Shifts */}
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Shifts</h2>
        {shiftLoading ? (
          <CardGridSkeleton count={3} />
        ) : (
          <div className="grid md:grid-cols-3 gap-4">
            {shifts?.map((s) => (
              <div key={s.ShiftID} className="doodle-card p-4 text-center">
                <h3 className="font-doodle text-lg font-bold text-doodle-text">{s.Name}</h3>
                <p className="font-doodle text-sm text-muted-foreground mt-1">{s.StartTime} — {s.EndTime}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Departments */}
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Departments by Group</h2>
        {deptLoading ? (
          <CardGridSkeleton count={8} />
        ) : (
          <div className="space-y-6">
            {grouped.map(([groupName, depts]) => (
              <div key={groupName}>
                <h3 className="font-doodle text-sm font-bold text-doodle-accent mb-2 border-b-2 border-dashed border-doodle-text/20 pb-1">{groupName}</h3>
                <div className="grid md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {depts?.map((d) => (
                    <div key={d.DepartmentID} className="px-3 py-2 border-2 border-doodle-text/10 rounded font-doodle text-sm">
                      {d.Name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DepartmentsShifts;
