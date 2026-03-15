import { FullConfig } from "@playwright/test";
import { testEnv } from "./utils/env";

/**
 * Global setup for Playwright tests
 * Polls backend service health endpoints directly via fetch (no browser required).
 * This avoids a dependency on a locally-installed browser binary, which is
 * important when running against Azure Playwright where the devcontainer only
 * needs to execute the setup script — not render a full page.
 *
 * Services checked:
 *   1. Static Web App  – GET webBaseUrl
 *   2. Functions API   – GET functionsBaseUrl/api/health
 *   3. DAB/GraphQL API – GET restApiBaseUrl/Product?$top=1
 */

interface ServiceCheck {
  name: string;
  url: string;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    // Treat any response (including 401/403) as "up" — only network errors mean down
    return res.status < 500;
  } catch {
    return false;
  }
}

async function globalSetup(_config: FullConfig) {
  console.log("🏥 Running global health check to warm up services...\n");

  const services: ServiceCheck[] = [
    { name: "Web App (SWA)", url: testEnv.webBaseUrl },
    { name: "Functions API", url: `${testEnv.functionsBaseUrl}/api/health` },
    {
      name: "GraphQL API (DAB)",
      url: `${testEnv.restApiBaseUrl}/Product?$top=1`,
    },
  ];

  console.log("   Services to check:");
  services.forEach((s) => console.log(`     • ${s.name}: ${s.url}`));
  console.log(
    "\n   ⏳ Waiting for all services to become healthy (max 5 minutes)...",
  );
  console.log("   💡 Polling every 10s until services are ready\n");

  const maxWaitTime = 5 * 60 * 1000;
  const pollInterval = 10_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const results = await Promise.all(
      services.map(async (svc) => ({
        ...svc,
        healthy: await isReachable(svc.url),
      })),
    );

    const healthyCount = results.filter((r) => r.healthy).length;
    const unhealthyCount = results.filter((r) => !r.healthy).length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    console.log(
      `   Status: ✅ ${healthyCount} healthy | ❌ ${unhealthyCount} unhealthy | ⏱️  ${elapsed}s elapsed`,
    );
    results.forEach((r) =>
      console.log(`     ${r.healthy ? "✅" : "❌"} ${r.name}`),
    );

    if (results.every((r) => r.healthy)) {
      console.log(
        `\n✅ All services are healthy and warmed up! (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
      );
      console.log("🎭 Ready to run Playwright tests\n");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  const healthUrl = `${testEnv.webBaseUrl}/health`;
  throw new Error(
    `Health check timeout after 5 minutes. Some services are still unreachable.\n` +
      `Azure services may need more time to cold start. Check ${healthUrl} manually.`,
  );
}

export default globalSetup;
