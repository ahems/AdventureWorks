import React, { useEffect, useState, useCallback } from "react";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  Square,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  getOrchestrationStatus,
  terminateOrchestration,
  OrchestrationStatus,
  JobResponse,
} from "@/services/utilityService";

interface UtilityStatusPanelProps {
  jobResponse: JobResponse;
  onComplete?: () => void;
}

const UtilityStatusPanel: React.FC<UtilityStatusPanelProps> = ({
  jobResponse,
  onComplete,
}) => {
  const [status, setStatus] = useState<OrchestrationStatus | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);

  const isDurable = jobResponse.statusQueryGetUri !== null;

  const fetchStatus = useCallback(async () => {
    if (!jobResponse.statusQueryGetUri) return;
    try {
      const currentStatus = await getOrchestrationStatus(
        jobResponse.statusQueryGetUri,
      );
      setStatus(currentStatus);
      if (
        currentStatus.runtimeStatus === "Completed" ||
        currentStatus.runtimeStatus === "Failed" ||
        currentStatus.runtimeStatus === "Terminated"
      ) {
        onComplete?.();
      }
    } catch {
      // silently ignore polling errors
    }
  }, [jobResponse.statusQueryGetUri, onComplete]);

  useEffect(() => {
    if (!isDurable) {
      // Queue-based job: no polling, show "Queued" immediately
      setStatus({ runtimeStatus: "Completed" });
      onComplete?.();
      return;
    }
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 2000);
    return () => clearInterval(statusInterval);
  }, [fetchStatus, isDurable, onComplete]);

  useEffect(() => {
    if (status?.runtimeStatus === "Running") {
      const timer = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [status?.runtimeStatus]);

  const handleCopyInstanceId = () => {
    navigator.clipboard.writeText(jobResponse.id);
    toast.success("Instance ID copied to clipboard");
  };

  const handleTerminate = async () => {
    if (!jobResponse.terminatePostUri) return;
    const ok = await terminateOrchestration(jobResponse.terminatePostUri);
    if (ok) {
      toast.info("Operation terminated");
      await fetchStatus();
    }
  };

  const formatElapsedTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const runtimeStatus = status?.runtimeStatus;

  const getStatusIcon = () => {
    switch (runtimeStatus) {
      case "Running":
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      case "Completed":
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case "Failed":
        return <XCircle className="w-5 h-5 text-red-500" />;
      case "Terminated":
        return <Square className="w-5 h-5 text-orange-500" />;
      case "Pending":
      default:
        return <Clock className="w-5 h-5 text-muted-foreground" />;
    }
  };

  const getStatusColor = () => {
    switch (runtimeStatus) {
      case "Running":
        return "text-blue-500";
      case "Completed":
        return "text-green-500";
      case "Failed":
        return "text-red-500";
      case "Terminated":
        return "text-orange-500";
      default:
        return "text-muted-foreground";
    }
  };

  if (!status) {
    return (
      <div className="mt-4 p-4 doodle-card bg-muted/50">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-doodle">Loading status...</span>
        </div>
      </div>
    );
  }

  const displayStatus = !isDurable ? "Queued" : (runtimeStatus ?? "Pending");

  return (
    <div className="mt-4 p-4 doodle-card bg-muted/50">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className={`font-doodle font-bold ${getStatusColor()}`}>
            {displayStatus}
          </span>
          {!isDurable && (
            <span className="text-xs text-muted-foreground font-doodle">
              (runs in background)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" />
          <span className="font-mono">{formatElapsedTime(elapsedTime)}</span>
        </div>
      </div>

      {/* Instance ID */}
      <div className="flex items-center gap-2 mb-3 p-2 bg-background/50 rounded">
        <span className="text-xs text-muted-foreground font-doodle">
          Instance:
        </span>
        <code className="text-xs font-mono flex-1 truncate">
          {jobResponse.id}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCopyInstanceId}
        >
          <Copy className="w-3 h-3" />
        </Button>
      </div>

      {/* Status Message */}
      {status.customStatus && (
        <p className="text-sm text-muted-foreground font-doodle mb-3">
          {String(status.customStatus)}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {runtimeStatus === "Running" && jobResponse.terminatePostUri && (
          <Button variant="destructive" size="sm" onClick={handleTerminate}>
            <Square className="w-3 h-3 mr-1" />
            Cancel
          </Button>
        )}
        {isDurable && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDetails(!showDetails)}
            className="ml-auto"
          >
            {showDetails ? (
              <>
                <ChevronUp className="w-3 h-3 mr-1" />
                Hide Details
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3 mr-1" />
                View Details
              </>
            )}
          </Button>
        )}
      </div>

      {/* Details Panel */}
      {showDetails && (
        <div className="mt-3 p-3 bg-background rounded text-xs font-mono overflow-auto max-h-40">
          <pre>{JSON.stringify(status, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

export default UtilityStatusPanel;
