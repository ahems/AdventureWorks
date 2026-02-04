#!/usr/bin/env node
/**
 * Warm-up script for Azure services
 * Calls health/ready endpoints to wake up Container Apps before running tests
 */

import { testEnv } from "./env";

interface WarmupConfig {
  url: string;
  name: string;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
}

const warmupEndpoint = async (config: WarmupConfig): Promise<void> => {
  const { url, name, maxRetries, retryDelayMs, timeoutMs } = config;

  console.log(`🔥 Warming up ${name}...`);
  console.log(`   URL: ${url}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const startTime = Date.now();
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Playwright-Warmup/1.0",
        },
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      if (response.ok) {
        console.log(`   ✅ ${name} ready (${response.status}) [${duration}ms]`);
        return;
      }

      console.log(
        `   ⚠️  Attempt ${attempt}/${maxRetries}: ${response.status} [${duration}ms]`,
      );
    } catch (error) {
      const duration = Date.now() - Date.now();
      if (error instanceof Error && error.name === "AbortError") {
        console.log(
          `   ⏱️  Attempt ${attempt}/${maxRetries}: Timeout after ${timeoutMs}ms`,
        );
      } else {
        console.log(
          `   ❌ Attempt ${attempt}/${maxRetries}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (attempt < maxRetries) {
      console.log(`   ⏳ Waiting ${retryDelayMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `Failed to warm up ${name} after ${maxRetries} attempts. Service may be unavailable.`,
  );
};

const main = async () => {
  console.log("🚀 Starting Azure services warm-up...\n");

  const warmupConfigs: WarmupConfig[] = [
    {
      url: `${testEnv.restApiBaseUrl}/Product`,
      name: "DAB API (REST)",
      maxRetries: 5,
      retryDelayMs: 3000,
      timeoutMs: 30000,
    },
    {
      url: `${testEnv.functionsBaseUrl}/api/addresses`,
      name: "Azure Functions",
      maxRetries: 5,
      retryDelayMs: 3000,
      timeoutMs: 30000,
    },
  ];

  try {
    // Warm up services in parallel for faster startup
    await Promise.all(warmupConfigs.map((config) => warmupEndpoint(config)));

    console.log("\n✅ All services warmed up successfully!");
    console.log("🎭 Ready to run Playwright tests\n");
    process.exit(0);
  } catch (error) {
    console.error(
      `\n❌ Warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "⚠️  Tests may experience timeouts. Consider checking Azure resources.\n",
    );
    process.exit(1);
  }
};

// Only run if executed directly (not imported)
if (require.main === module) {
  main();
}

export { warmupEndpoint, WarmupConfig };
