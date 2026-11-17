import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright");
const directory = resolve(process.argv[2]);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const reportUrl = pathToFileURL(resolve(directory, "report.html")).href;
  await context.route("**/*", (route) => route.request().url() === reportUrl ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(pathToFileURL(resolve(directory, "report.html")).href);
  await page.pdf({ path: resolve(directory, "report.pdf"), printBackground: true, preferCSSPageSize: true });
} finally {
  await browser.close();
}
