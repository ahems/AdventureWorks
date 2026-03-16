import { FullConfig } from "@playwright/test";
import { testEnv } from "./utils/env";

/**
 * Global setup for Admin Portal Playwright tests.
 * Checks that the admin SWA and backend APIs are reachable before running tests.
 */

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function globalSetupAdmin(_config: FullConfig) {
  console.log("🏥 Admin Portal: running health checks...\n");

  const services = [
    { name: "Admin SWA", url: testEnv.adminWebBaseUrl },
    { name: "Functions API", url: `${testEnv.functionsBaseUrl}/api/health` },
    {
      name: "GraphQL API (DAB)",
      url: `${testEnv.restApiBaseUrl}/Product?$top=1`,
    },
  ];

  services.forEach((s) => console.log(`   • ${s.name}: ${s.url}`));
  console.log("\n   ⏳ Waiting for services (max 3 minutes)...\n");

  const maxWaitTime = 3 * 60 * 1000;
  const pollInterval = 10_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const results = await Promise.all(
      services.map(async (svc) => ({
        ...svc,
        healthy: await isReachable(svc.url),
      })),
    );

    const allHealthy = results.every((r) => r.healthy);
    if (allHealthy) {
      console.log("   ✅ All admin services healthy\n");
      return;
    }

    const unhealthy = results.filter((r) => !r.healthy).map((r) => r.name);
    console.log(`   ⏳ Unhealthy: ${unhealthy.join(", ")}. Retrying in 10s...`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  console.warn("   ⚠️  Some services may not be ready — proceeding anyway.\n");
}

export default globalSetupAdmin;
