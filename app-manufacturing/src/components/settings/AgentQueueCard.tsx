import React from "react";
import { Link } from "react-router-dom";
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
import {
  Bot,
  Trash2,
  AlertTriangle,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import {
  fetchAgentQueueStatus,
  clearAgentQueue,
  clearAgentPoisonQueue,
} from "@/services/agentApi";
import { toast } from "sonner";

export function AgentQueueCard() {
  const qc = useQueryClient();

  const { data: queueStatus } = useQuery({
    queryKey: ["agent-queue-status"],
    queryFn: fetchAgentQueueStatus,
    staleTime: 10_000,
  });

  const clearMainMutation = useMutation({
    mutationFn: clearAgentQueue,
    onSuccess: () => {
      toast.success(
        "Agent queue cleared — pending orders will not be analysed.",
      );
      qc.invalidateQueries({ queryKey: ["agent-queue-status"] });
    },
    onError: (e: Error) => toast.error(`Clear failed: ${e.message}`),
  });

  const clearPoisonMutation = useMutation({
    mutationFn: clearAgentPoisonQueue,
    onSuccess: () => {
      toast.success("Poison queue cleared.");
      qc.invalidateQueries({ queryKey: ["agent-queue-status"] });
    },
    onError: (e: Error) => toast.error(`Clear failed: ${e.message}`),
  });

  const pending = queueStatus?.pending ?? 0;
  const poisonDepth = queueStatus?.poisonQueue ?? 0;

  return (
    <Card className="doodle-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-doodle-blue" /> AI Manufacturing Agent
        </CardTitle>
        <CardDescription>
          Manage the agent's order queue and view its activity feed. To change
          the agent's autonomy mode, visit the Agent Control page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Queue depth summary */}
        <div className="flex flex-wrap gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Pending:</span>
            <Badge
              variant={
                pending > 20
                  ? "destructive"
                  : pending > 5
                    ? "secondary"
                    : "outline"
              }
            >
              {pending}
            </Badge>
          </div>
          {poisonDepth > 0 && (
            <div className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Failed (poison):</span>
              <Badge variant="destructive">{poisonDepth}</Badge>
            </div>
          )}
          {queueStatus?.isProcessing && (
            <Badge
              variant="outline"
              className="border-doodle-green text-doodle-green"
            >
              Processing
            </Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={pending === 0 || clearMainMutation.isPending}
            onClick={() => {
              if (
                confirm(
                  `Remove all ${pending} pending orders from the agent queue? They will not be analysed.`,
                )
              ) {
                clearMainMutation.mutate();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Queue {pending > 0 && `(${pending})`}
          </Button>

          {poisonDepth > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              disabled={clearPoisonMutation.isPending}
              onClick={() => {
                if (
                  confirm(
                    `Remove ${poisonDepth} permanently failed items from the poison queue?`,
                  )
                ) {
                  clearPoisonMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear Failed ({poisonDepth})
            </Button>
          )}

          <Link to="/manufacturing-agent">
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Agent Control &amp; Activity Feed
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
