import type { ReactNode } from "react";
import { useCan } from "@/hooks/useCan";

/** Renders `children` only when the signed-in employee holds `scope`. */
export function Can({
  scope,
  children,
  fallback = null,
}: {
  scope: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <>{useCan(scope) ? children : fallback}</>;
}
