import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const ts = createRequire(new URL("../../app-admin/package.json", import.meta.url))("typescript");

async function loadDownload(status = 200, contentType = "application/pdf") {
  const calls = [];
  const links = [];
  const revoked = [];
  const timers = [];
  const blobs = [];
  const window = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(status === 200 ? "%PDF-test" : '{"error":"denied"}', {
        status, headers: { "Content-Type": contentType },
      });
    },
  };
  class LocalURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return "blob:local-receipt"; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = vm.createContext({
    window, URL: LocalURL, Request, Headers,
    fetch: (...args) => window.fetch(...args),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    document: {
      createElement: tag => {
        assert.equal(tag, "a");
        const link = { click() { this.clicked = true; }, remove() { this.removed = true; } };
        links.push(link);
        return link;
      },
      body: { appendChild: link => { link.appended = true; } },
    },
  });
  const config = new vm.SyntheticModule(["getFunctionsApiUrl"], function () {
    this.setExport("getFunctionsApiUrl", () => "https://functions.example.test");
  }, { context });
  const auth = new vm.SyntheticModule(["hasSession", "getFunctionsAccessToken"], function () {
    this.setExport("hasSession", () => true);
    this.setExport("getFunctionsAccessToken", async () => "test-functions-token");
  }, { context });
  async function load(path) {
    const source = await readFile(new URL(`../../app-admin/src/services/${path}.ts`, import.meta.url), "utf8");
    const module = new vm.SourceTextModule(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText, { context });
    await module.link(name => name === "@/lib/utils" ? config : auth);
    await module.evaluate();
    return module.namespace;
  }
  (await load("functionsAuthInterceptor")).installFunctionsAuthInterceptor();
  return { download: (await load("receiptService")).downloadReceipt, calls, links, timers, blobs, revoked };
}

test("receipt download fetches PDF with Functions bearer token and downloads only a local blob", async () => {
  const env = await loadDownload();
  await env.download(75126);
  assert.equal(env.calls.length, 1);
  const call = env.calls[0];
  assert.equal(call.url, "https://functions.example.test/api/orders/75126/receipt");
  assert.equal(call.init.headers.get("Authorization"), "Bearer test-functions-token");
  assert.equal(env.blobs.length, 1);
  assert.equal(await env.blobs[0].text(), "%PDF-test");
  assert.equal(env.links.length, 1);
  assert.deepEqual(
    { href: env.links[0].href, download: env.links[0].download, clicked: env.links[0].clicked, removed: env.links[0].removed },
    { href: "blob:local-receipt", download: "receipt-SO75126.pdf", clicked: true, removed: true },
  );
  assert.equal(env.revoked.length, 0);
  assert.equal(env.timers[0].delay, 60_000);
  env.timers[0].callback();
  assert.deepEqual(env.revoked, ["blob:local-receipt"]);
});

for (const status of [401, 403, 404, 500]) {
  test(`HTTP ${status} is surfaced without downloading an error response`, async () => {
    const env = await loadDownload(status, "application/json");
    await assert.rejects(env.download(75126), new RegExp(`HTTP ${status}`));
    assert.equal(env.links.length, 0);
    assert.equal(env.blobs.length, 0);
  });
}

test("successful non-PDF response is rejected rather than downloaded", async () => {
  const env = await loadDownload(200, "text/html");
  await assert.rejects(env.download(75126), /did not return a PDF/);
  assert.equal(env.links.length, 0);
});

test("orders receipt action never navigates directly to a protected receipt URL", async () => {
  const source = await readFile(new URL("../../app-admin/src/pages/OrdersPage.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("await downloadReceipt(order.SalesOrderID)"));
  assert.ok(source.includes("disabled={isDownloading}"));
  assert.ok(source.includes('title: "Unable to download receipt"'));
  assert.ok(!source.includes("href={downloadUrl}"));
  assert.ok(!source.includes("/receipt`"));
});
