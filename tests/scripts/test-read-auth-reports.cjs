const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const test = require("node:test");
const vm = require("node:vm");
const source = readFileSync(require("node:path").join(__dirname, "../auth/read-reports.cjs"), "utf8");

async function readReports(defect) {
  const runId = "20261110T195420Z-c3d67675-a361-41a8-baf8-5f89cc43eedf";
  const config = { runId, prefix: "auth-assurance/" + runId + "/", clientId: "expected-client",
    principalId: "expected-principal", tenantId: "expected-tenant", endpoint: "https://storage.example.invalid/" };
  if (defect === "prefix") config.prefix = "another-prefix/";
  if (defect === "endpoint") config.endpoint = "http://storage.example.invalid/";
  const files = Object.fromEntries(["report.pdf", "report.html", "report.json", "junit.xml"]
    .map(name => [name, defect === "large-valid" ? Buffer.alloc(200000, 1) : Buffer.from("unit fixture " + name)]));
  if (defect === "boundary-valid" || defect === "boundary-exceeded") {
    const others = Object.entries(files).filter(([name]) => name !== "report.pdf")
      .reduce((sum, [, data]) => sum + data.length, 0);
    files["report.pdf"] = Buffer.alloc(1024 * 1024 - others + (defect === "boundary-exceeded" ? 1 : 0));
  }
  const manifest = Object.fromEntries(Object.entries(files).map(([name, data]) =>
    [name, { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }]));
  if (defect === "checksum") manifest["report.pdf"].sha256 = "a".repeat(64);
  if (defect === "missing") delete manifest["report.pdf"];
  if (defect === "oversized") manifest["report.pdf"].bytes = 1024 * 1024 + 1;
  const token = "header." + Buffer.from(JSON.stringify({
    oid: defect === "identity" ? "foreign" : config.principalId, tid: config.tenantId,
  })).toString("base64url") + ".private-token-fixture";
  const calls = [];
  let document;
  await vm.runInNewContext(source, {
    require, Buffer, URL, URLSearchParams, AbortSignal,
    globalThis: { authReportConfig: config },
    process: { env: { IDENTITY_ENDPOINT: "http://identity.internal/token", IDENTITY_HEADER: "private-header-fixture" },
      exit() {} },
    console: { log: value => { document = JSON.parse(value.slice("AUTH_ASSURANCE_DOWNLOAD_RESULT:".length)); } },
    fetch: async (target, options) => {
      const url = new URL(target);
      calls.push(url);
      assert.equal(options.redirect, "error");
      if (url.hostname === "identity.internal") {
        assert.equal(url.searchParams.get("client_id"), config.clientId);
        assert.equal(url.searchParams.get("resource"), "https://storage.azure.com/");
        return { status: 200, json: async () => ({ access_token: token }) };
      }
      assert.equal(url.origin, "https://storage.example.invalid");
      const prefix = "/adventureworks-receipts/auth-assurance/" + runId + "/";
      assert.ok(url.pathname.startsWith(prefix));
      const name = url.pathname.slice(prefix.length);
      assert.ok(name === "artifacts.json" || Object.hasOwn(files, name));
      const data = name === "artifacts.json" ? Buffer.from(JSON.stringify(manifest)) : files[name];
      return { status: defect === "denied" ? 403 : 200,
        headers: { get: () => String(data.length) }, body: (async function* () { yield data; })() };
    },
  });
  assert.ok(!JSON.stringify(document).includes(token));
  assert.ok(!JSON.stringify(document).includes("private-header-fixture"));
  return { document, calls };
}

test("private reports use explicit runtime MI, exact run prefix, bounded hashes and no credentials in output", async () => {
  const { document, calls } = await readReports();
  assert.equal(document.checks.length, 2);
  assert.ok(document.checks.every(check => check.status === "PASS"));
  assert.equal(Object.keys(document.artifacts).length, 4);
  assert.equal(calls.length, 6);
});

test("private recovery accepts expanded reports within the reviewed bound", async () => {
  for (const [fixture, expected] of [["large-valid", 800000], ["boundary-valid", 1024 * 1024]]) {
    const { document } = await readReports(fixture);
    assert.ok(document.checks.every(check => check.status === "PASS"));
    assert.equal(Object.values(document.artifacts).reduce((sum, item) => sum + item.bytes, 0), expected);
  }
});

test("identity, prefix, endpoint, manifest, size, hash and authorization failures fail explicitly", async () => {
  for (const defect of ["identity", "prefix", "endpoint", "missing", "oversized", "boundary-exceeded",
    "checksum", "denied"]) {
    const { document, calls } = await readReports(defect);
    assert.ok(document.checks.some(check => check.status === "FAIL"), defect);
    assert.equal(document.artifacts, undefined);
    if (defect === "identity") assert.equal(calls.length, 1);
    if (defect === "prefix") assert.equal(calls.length, 0);
    if (defect === "endpoint") assert.equal(calls.length, 1);
  }
});
