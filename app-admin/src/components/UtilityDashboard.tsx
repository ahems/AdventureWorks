import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertCircle, Clock } from "lucide-react";

export interface RecentExecution {
  name: string;
  time: string;
  status: "success" | "failed" | "running";
}

interface UtilityDashboardProps {
  recentExecutions?: RecentExecution[];
}

const ExecutionItem: React.FC<RecentExecution> = ({ name, time, status }) => {
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        {status === "success" && (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
        {status === "failed" && (
          <AlertCircle className="w-4 h-4 text-red-500" />
        )}
        {status === "running" && (
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        )}
        <span className="font-doodle text-sm">{name}</span>
      </div>
      <span className="font-doodle text-xs text-muted-foreground">
        {formatTime(time)}
      </span>
    </div>
  );
};

const UtilityDashboard: React.FC<UtilityDashboardProps> = ({
  recentExecutions = [],
}) => {
  if (recentExecutions.length === 0) return null;

  return (
    <div className="mb-8">
      <Card className="doodle-card">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-primary" />
            <h3 className="font-doodle font-bold text-sm">
              Recent Activity (this session)
            </h3>
          </div>
          <div className="space-y-0">
            {recentExecutions.map((exec, index) => (
              <ExecutionItem key={index} {...exec} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default UtilityDashboard;
