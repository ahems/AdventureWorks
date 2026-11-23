// Loads each SPA anonymously and waits until Application Insights accepts its browser telemetry.
// Read-only: no sign-in, and every request other than the page, its assets and the track POST is aborted.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const SITES = [
  ["app-eshop", "APP_URL"],
  ["app-admin", "APP_ADMIN_URL"],
  ["app-manufacturing", "APP_MANUFACTURING_URL"],
];
const TRACK_PATH = /^\/v2(\.1)?\/track$/;
const TRACK_HOST = /\.(applicationinsights\.azure\.com|monitor\.azure\.com)$/;
const WAIT_MS = 45000;

export function trackedEnvelopes(postData) {
  if (typeof postData !== "string" || !postData) return [];
  const text = postData.trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

export function summarizeEnvelopes(envelopes, role) {
  const roles = new Set(envelopes.map((item) => item?.tags?.["ai.cloud.role"]));
  const operations = new Set(envelopes.map((item) => item?.tags?.["ai.operation.id"])
    .filter((value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value)));
  return { items: envelopes.length, roleMatches: roles.size === 1 && roles.has(role),
           operationIds: [...operations].slice(0, 4) };
}

export function allSitesVerified(sites) {
  return sites.length === SITES.length && SITES.every(([role]) => {
    const matches = sites.filter(site => site.role === role);
    return matches.length === 1 && !matches[0].error &&
      matches[0].accepted > 0 && matches[0].accepted === matches[0].items &&
      matches[0].roleMatches === true;
  });
}

async function probe(browser, role, siteUrl) {
  const site = new URL(siteUrl);
  if (site.protocol !== "https:" || site.username || site.password) throw new Error(`${role} URL is not plain https`);
  const context = await browser.newContext();
  const result = { role, accepted: 0, items: 0, roleMatches: false, operationIds: [], blocked: 0 };
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const track = TRACK_HOST.test(url.hostname) && TRACK_PATH.test(url.pathname) &&
        route.request().method() === "POST";
      // Same-origin assets/config and the telemetry beacon only; APIs and identity calls are not needed.
      if (url.origin === site.origin || track) return route.continue();
      result.blocked++;
      return route.abort();
    });
    const page = await context.newPage();
    const accepted = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (!TRACK_HOST.test(url.hostname) || !TRACK_PATH.test(url.pathname) || response.status() !== 200) return false;
      Object.assign(result, summarizeEnvelopes(trackedEnvelopes(response.request().postData()), role));
      const body = await response.json().catch(() => ({}));
      result.accepted = Number.isInteger(body.itemsAccepted) ? body.itemsAccepted : 0;
      return result.accepted > 0;
    }, { timeout: WAIT_MS });
    await page.goto(site.href, { waitUntil: "load", timeout: WAIT_MS });
    await accepted;
  } catch (error) {
    result.error = error?.name === "TimeoutError" ? "timeout" : "probe-failed";
  } finally {
    await context.close();
  }
  return result;
}

async function main() {
  const index = process.argv.indexOf("--output");
  const output = index >= 0 ? process.argv[index + 1] : null;
  if (!output) throw new Error("--output is required");
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
  const browser = await chromium.launch({ headless: true });
  const sites = [];
  try {
    for (const [role, key] of SITES) {
      if (!process.env[key]) throw new Error(`${key} is required`);
      sites.push(await probe(browser, role, process.env[key]));
    }
  } finally {
    await browser.close();
  }
  await writeFile(output, JSON.stringify({ schemaVersion: 1, sites }, null, 2) + "\n");
  if (!allSitesVerified(sites)) {
    console.error("Frontend telemetry was not fully accepted and correctly attributed for all three sites.");
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message ?? "Frontend telemetry probe failed");
    process.exit(1);
  });
}
