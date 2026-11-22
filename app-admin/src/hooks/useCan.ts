import { useAuth } from "@/context/AuthContext";
import { hasScope } from "@/lib/permissions";

/**
 * Whether the signed-in employee's token grants `scope`. Re-evaluated when the
 * signed-in user changes. UI gating only — the APIs still enforce authorization.
 */
export function useCan(scope: string): boolean {
  const { user } = useAuth();
  return !!user && hasScope(scope);
}
