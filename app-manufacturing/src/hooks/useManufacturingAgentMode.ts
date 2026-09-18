import { useQuery } from "@tanstack/react-query";
import { fetchAgentConfig } from "@/services/agentApi";

/**
 * Returns the current manufacturing agent mode and whether the agent is
 * actively controlling production decisions (mode > ReadOnly).
 *
 * Stale time is 30 s — frequent enough to pick up mode changes but avoids
 * hammering the config endpoint on every render.
 */
export function useManufacturingAgentMode() {
  const { data, isLoading } = useQuery({
    queryKey: ["manufacturing-agent-config"],
    queryFn: fetchAgentConfig,
    staleTime: 30_000,
    retry: 1,
  });

  return {
    mode: data?.mode ?? 0,
    modeLabel: data?.modeLabel ?? "Read-Only",
    isAgentActive: data?.isAgentActive ?? false,
    isLoading,
  };
}
