import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, CheckCircle2, XCircle, Clock, Copy, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { getOrchestrationStatus, terminateOrchestration, OrchestrationStatus } from '@/services/mockUtilityService';
import { Progress } from '@/components/ui/progress';

interface UtilityStatusPanelProps {
  instanceId: string;
  onComplete?: () => void;
}

const UtilityStatusPanel: React.FC<UtilityStatusPanelProps> = ({ instanceId, onComplete }) => {
  const [status, setStatus] = useState<OrchestrationStatus | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);

  const fetchStatus = useCallback(() => {
    const currentStatus = getOrchestrationStatus(instanceId);
    setStatus(currentStatus);
    
    if (currentStatus?.status === 'Completed' || currentStatus?.status === 'Failed' || currentStatus?.status === 'Terminated') {
      onComplete?.();
    }
  }, [instanceId, onComplete]);

  useEffect(() => {
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 1000);
    
    return () => clearInterval(statusInterval);
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.status === 'Running') {
      const timer = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [status?.status]);

  const handleCopyInstanceId = () => {
    navigator.clipboard.writeText(instanceId);
    toast.success('Instance ID copied to clipboard');
  };

  const handleTerminate = () => {
    const success = terminateOrchestration(instanceId);
    if (success) {
      toast.info('Operation terminated');
      fetchStatus();
    }
  };

  const formatElapsedTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusIcon = () => {
    switch (status?.status) {
      case 'Running':
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      case 'Completed':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case 'Failed':
        return <XCircle className="w-5 h-5 text-red-500" />;
      case 'Terminated':
        return <Square className="w-5 h-5 text-orange-500" />;
      case 'Pending':
      default:
        return <Clock className="w-5 h-5 text-muted-foreground" />;
    }
  };

  const getStatusColor = () => {
    switch (status?.status) {
      case 'Running':
        return 'text-blue-500';
      case 'Completed':
        return 'text-green-500';
      case 'Failed':
        return 'text-red-500';
      case 'Terminated':
        return 'text-orange-500';
      default:
        return 'text-muted-foreground';
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

  return (
    <div className="mt-4 p-4 doodle-card bg-muted/50">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className={`font-doodle font-bold ${getStatusColor()}`}>
            {status.status}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" />
          <span className="font-mono">{formatElapsedTime(elapsedTime)}</span>
        </div>
      </div>

      {/* Instance ID */}
      <div className="flex items-center gap-2 mb-3 p-2 bg-background/50 rounded">
        <span className="text-xs text-muted-foreground font-doodle">Instance:</span>
        <code className="text-xs font-mono flex-1 truncate">{instanceId}</code>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopyInstanceId}>
          <Copy className="w-3 h-3" />
        </Button>
      </div>

      {/* Progress Bar */}
      {status.progress !== undefined && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span className="font-doodle">Progress</span>
            <span className="font-mono">{Math.round(status.progress)}%</span>
          </div>
          <Progress value={status.progress} className="h-2" />
        </div>
      )}

      {/* Status Message */}
      {status.message && (
        <p className="text-sm text-muted-foreground font-doodle mb-3">{status.message}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {status.status === 'Running' && (
          <Button variant="destructive" size="sm" onClick={handleTerminate}>
            <Square className="w-3 h-3 mr-1" />
            Cancel
          </Button>
        )}
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
