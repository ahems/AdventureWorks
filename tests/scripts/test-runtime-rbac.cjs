const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const receiver = require("./runtime-webpubsub-receiver.cjs");

const source = readFileSync(require("node:path").join(__dirname, "runtime-rbac-probe.cjs"), "utf8");
const fixtureSource = readFileSync(require("node:path").join(__dirname, "runtime-functions-push-fixture.cjs"), "utf8");
const seedSource = readFileSync(require("node:path").join(__dirname, "seed-sql-identity-probe.cjs"), "utf8");

async function seedProbe(options = {}) {
  const calls = [];
  let result;
  const config = {
    endpoint: options.foreignEndpoint ? "https://attacker.example.invalid/" : "https://storage123.file.core.windows.net/",
    account: "storage123", suffix: "core.windows.net", share: "seed-job-logs",
    clientId: "runtime-client", principalId: "runtime-principal", tenantId: "tenant",
    start: options.midnight ? "2020-01-01T23:59:58.999999Z" : "2020-01-01T00:00:00.123456Z",
    end: options.midnight ? "2020-01-02T00:00:10Z" : "2020-01-01T00:10:00Z",
    seedClient: "seed-client", seedName: "seed-identity", sqlServer: "sql-server",
    sqlDatabase: "database", scriptVersion: "ABCD1234",
  };
  const filename = options.midnight ? "seed-20200102-000001.log" : "seed-20200101-000001.log";
  const entries = [
    "DATABASE SEEDING SCRIPT STARTED",
    "Seed script version: ABCD1234",
    "Environment variables:",
    "SQL Server: sql-server",
    "SQL Database: database",
    "Managed Identity: seed-identity",
    "Tenant ID: tenant",
    "Client ID: seed-client",
    "Successfully connected to Azure using Managed Identity",
    "Obtained Azure AD access token for SQL using Managed Identity",
    "Successfully connected to SQL Database",
    "private log content that must never appear in evidence",
  ];
  if (options.missingSuccess) entries.splice(10, 1);
  if (options.unordered) [entries[8], entries[10]] = [entries[10], entries[8]];
  const text = entries.join("\n");
  await vm.runInNewContext(seedSource, {
    globalThis: { seedSqlConfig: config }, URL, Buffer, AbortSignal,
    setTimeout: (callback) => { callback(); },
    process: { env: { IDENTITY_ENDPOINT: options.foreignIdentity ?
      "http://attacker.example.invalid/token" : "http://127.0.0.1:1234/token",
    IDENTITY_HEADER: "secret-header" }, exit() {} },
    console: { log: (value) => { result = JSON.parse(value.slice("AUTH_SEED_SQL_RESULT:".length)); } },
    fetch: async (target, request) => {
      const url = new URL(target);
      calls.push({ url, request });
      assert.equal(request.redirect, "error");
      if (url.hostname === "127.0.0.1") {
        assert.equal(request.headers["X-IDENTITY-HEADER"], "secret-header");
        assert.equal(url.searchParams.get("client_id"), config.clientId);
        const claims = { oid: options.wrongIdentity ? "other" : config.principalId,
          tid: options.wrongTenant ? "other" : config.tenantId,
          appid: options.wrongClient ? "other" : config.clientId };
        return { status: 200, json: async () => ({ access_token:
          "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature" }) };
      }
      assert.equal(url.hostname, "storage123.file.core.windows.net");
      assert.equal(request.headers["x-ms-file-request-intent"], "backup");
      assert.ok(request.headers.Authorization.startsWith("Bearer "));
      if (url.searchParams.get("comp") === "list") {
        if (options.networkFailure) throw new Error("sensitive-network-error");
        const matchingDay = url.searchParams.get("prefix") === filename.slice(0, 13);
        const file = `<File><Name>${filename}</Name></File>`;
        const files = matchingDay && !options.noLog ? file + (options.ambiguous ? file : "") : "";
        const marker = options.continuation ? "<NextMarker>more</NextMarker>" : "<NextMarker />";
        return { status: options.deniedList ? 403 : 200,
          text: async () => `<Entries>${files}</Entries>${marker}` };
      }
      assert.equal(url.pathname, "/seed-job-logs/" + filename);
      assert.equal(request.headers.Range, "bytes=0-65535");
      return { status: 206, headers: { get: () => options.oversized ? "65537" :
        String(Buffer.byteLength(text) + (options.truncated ? 1 : 0)) }, text: async () => text };
    },
  });
  return { calls, checks: result.checks };
}

test("seed SQL log check reads only the uniquely matched log and withholds its content", async () => {
  for (const options of [{}, { midnight: true }]) {
    const { calls, checks } = await seedProbe(options);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, "PASS");
    assert.equal(calls.filter(({ url }) => url.searchParams.get("comp") === "list").length,
      options.midnight ? 2 : 1);
    assert.equal(calls.filter(({ url }) => url.pathname.endsWith(".log")).length, 1);
    assert.ok(!JSON.stringify(checks).includes("private log content"));
  }
});

test("seed SQL log check blocks foreign targets or identities before sending storage credentials", async () => {
  for (const options of [{ foreignEndpoint: true }, { foreignIdentity: true }, { wrongIdentity: true },
    { wrongTenant: true }, { wrongClient: true }]) {
    const { calls, checks } = await seedProbe(options);
    assert.equal(checks[0].status, "BLOCKED");
    assert.ok(calls.every(({ url }) => url.hostname !== "storage123.file.core.windows.net"));
    assert.ok(calls.every(({ url }) => url.hostname !== "attacker.example.invalid"));
    assert.ok(!JSON.stringify(checks).includes("secret-header"));
  }
});

test("seed SQL log check blocks incomplete, ambiguous or unsafe evidence without leaking errors", async () => {
  for (const options of [{ deniedList: true }, { networkFailure: true }, { noLog: true }, { ambiguous: true },
    { continuation: true }, { missingSuccess: true }, { unordered: true }, { oversized: true },
    { truncated: true }]) {
    const { calls, checks } = await seedProbe(options);
    assert.equal(checks[0].status, "BLOCKED");
    assert.ok(calls.every(({ request }) => !request.method || request.method === "GET"));
    assert.ok(!JSON.stringify(checks).includes("private log content"));
    assert.ok(!JSON.stringify(checks).includes("sensitive-network-error"));
  }
});

async function probe(options = {}) {
  const calls = [];
  let result;
  const config = {
    clientId: "runtime-client", principalId: "runtime-principal", tenantId: "tenant",
    storageId: "/storage", acrId: "/registry", registry: "registry.example.invalid",
    repository: "admin", tag: "deployed",
  };
  if (options.email) Object.assign(config, {
    recipient: "approved@example.invalid", communicationEndpoint: "https://email.example.invalid",
    senderDomain: "sender.example.invalid",
  });
  if (options.webPubSub) config.webPubSub = {
    host: options.invalidWebPubSubHost ? "push.example.invalid/path" : "push.example.invalid",
    probeId: "12345678-1234-4123-8123-123456789abc",
  };
  if (options.keyVault) config.keyVault = {
    uri: options.invalidVault ? "https://other.example.invalid/path" : "https://demo.vault.example.invalid",
    certificate: "mcp-signing",
  };
  if (options.serviceProfile) config.serviceProfile = {
    origin: options.invalidServiceOrigin ? "https://mcp.example.invalid/path" : "https://mcp.example.invalid",
  };
  const response = (status, document = {}, location = null) => ({
    status, json: async () => document, text: async () => JSON.stringify(document),
    headers: { get: (name) => name === "operation-location" ? location : "application/json" },
  });
  await vm.runInNewContext(source, {
    globalThis: { authRbacConfig: config }, URL, URLSearchParams, Buffer, AbortSignal,
    require, setTimeout: (callback) => { callback(); },
    process: { env: { IDENTITY_ENDPOINT: "http://identity.internal/token", IDENTITY_HEADER: "test-header" },
      exit() {} },
    console: { log: (value) => { result = JSON.parse(value.slice("AUTH_RUNTIME_RBAC_RESULT:".length)); } },
    fetch: async (target, request) => {
      const url = new URL(target);
      calls.push({ url, method: request.method || "GET" });
      if (url.hostname === "identity.internal") {
        assert.equal(url.searchParams.get("client_id"), config.clientId);
        const claims = { oid: options.wrongIdentity ? "other-principal" : config.principalId,
          tid: options.wrongTenant ? "other-tenant" : config.tenantId, appid: config.clientId,
          aud: options.wrongAudience ? "https://other.example.invalid" : url.searchParams.get("resource") };
        return response(200, { access_token: "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature" });
      }
      if (url.hostname === "management.azure.com") return response(options.managementAllowed ? 200 : 403);
      if (url.hostname === "mcp.example.invalid" && url.pathname === "/token") {
        assert.equal(request.method, "POST");
        assert.equal(request.body.get("resource"), "https://mcp.example.invalid/mcp");
        const scope = request.body.get("scope");
        if (scope !== "mcp.access products.read") {
          if ((scope.endsWith("mcp.admin") && options.adminGrantAllowed) ||
              (scope.endsWith("manufacturing.write") && options.manufacturingGrantAllowed))
            return response(200, { access_token: "must-not-appear-in-evidence" });
          return response(400, { error: "invalid_scope" });
        }
        const claims = {
          iss: "https://mcp.example.invalid/", aud: "https://mcp.example.invalid/mcp",
          sub: "service:" + config.principalId, category: "service", app: "adventureworks-agents",
          scope: options.broadServiceToken ? "mcp.access products.read mcp.admin" : "mcp.access products.read",
          exp: Math.floor(Date.now() / 1000) + 600,
        };
        return response(200, { token_type: "Bearer",
          access_token: "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature" });
      }
      if (url.hostname === "mcp.example.invalid" && url.pathname === "/mcp") {
        assert.equal(request.method, "POST");
        const body = JSON.parse(request.body);
        assert.deepEqual(body.params.arguments, { productId: 0 });
        assert.ok(["get_product_details", "get_product_availability"].includes(body.params.name));
        const allowed = body.params.name === "get_product_details";
        const isError = !allowed && !options.serviceToolAllowed;
        const text = allowed ? "Product ID 0 not found" :
          isError ? "This service is not authorized to call this tool." : "unexpected data";
        return response(200, { jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text }] } });
      }
      if (url.pathname === "/oauth2/exchange") return response(200, { refresh_token: "test-refresh" });
      if (url.pathname === "/oauth2/token") {
        assert.equal(request.body.get("scope"), "repository:admin:pull");
        return response(200, { access_token: "test-repository" });
      }
      if (url.pathname === "/v2/admin/manifests/deployed") return response(200, { schemaVersion: 2 });
      if (url.hostname === "demo.vault.example.invalid") {
        assert.equal(url.pathname, "/secrets/mcp-signing/versions");
        assert.equal(url.searchParams.get("api-version"), "7.4");
        assert.equal(request.method || "GET", "GET");
        return response(options.vaultDenied ? 403 : options.wrongAudience ? 401 : 200, { value: [{
          id: options.foreignMetadata ? "https://other.example.invalid/secrets/mcp-signing/abc" :
            "https://demo.vault.example.invalid/secrets/mcp-signing/abc",
          attributes: { enabled: !options.disabledVersion },
        }] });
      }
      if (url.pathname === "/api/hubs/adventureworks/groups/utilities/:send") {
        assert.equal(url.hostname, "push.example.invalid");
        assert.equal(url.searchParams.get("api-version"), "2024-12-01");
        assert.equal(request.method, "POST");
        assert.deepEqual(JSON.parse(request.body), { event: "auth-assurance-probe", probeId: config.webPubSub.probeId });
        if (options.webPubSubNetworkFailure) throw new Error("uncertain POST");
        return response(options.webPubSubDenied ? 403 : 202);
      }
      if (url.pathname === "/emails:send") {
        assert.equal(request.method, "POST");
        assert.equal(JSON.parse(request.body).recipients.to[0].address, config.recipient);
        if (options.emailNetworkFailure) throw new Error("uncertain POST");
        return response(options.emailDenied ? 401 : 202, {}, options.externalOperation ?
          "https://other.example.invalid/emails/operations/test" : "/emails/operations/test");
      }
      if (url.pathname === "/emails/operations/test") return response(200, { status: options.emailFailed ? "Failed" : "Succeeded" });
      assert.fail("Unexpected runtime request: " + url.pathname);
    },
  });
  return { calls, checks: result.checks };
}

test("read-only probe checks actual identity, management denials and repository pull without email", async () => {
  const { calls, checks } = await probe();
  assert.equal(checks.length, 3);
  assert.ok(checks.every((check) => check.status === "PASS"));
  assert.ok(calls.every(({ url }) => url.hostname !== "email.example.invalid"));
  assert.ok(calls.filter(({ url }) => url.hostname === "management.azure.com").every(({ method }) => method === "GET"));
});

test("opt-in email sends exactly once and polls the service operation", async () => {
  const { calls, checks } = await probe({ email: true });
  assert.equal(checks.length, 5);
  assert.ok(checks.every((check) => check.status === "PASS"));
  assert.equal(calls.filter(({ url }) => url.pathname === "/emails:send").length, 1);
  assert.equal(calls.filter(({ url }) => url.pathname === "/emails/operations/test").length, 1);
});

test("wrong managed identity or allowed management access fails before email", async () => {
  for (const options of [{ wrongIdentity: true }, { managementAllowed: true }]) {
    const { calls, checks } = await probe({ ...options, email: true });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    assert.ok(calls.every(({ url }) => url.hostname !== "email.example.invalid"));
  }
});

test("denied or uncertain email POST is never retried", async () => {
  for (const options of [{ emailDenied: true }, { emailNetworkFailure: true }]) {
    const { calls, checks } = await probe({ ...options, email: true });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    assert.equal(calls.filter(({ url }) => url.pathname === "/emails:send").length, 1);
    assert.equal(calls.filter(({ url }) => url.pathname === "/emails/operations/test").length, 0);
  }
});

test("untrusted operation origin is not followed and failed operation is not success-shaped", async () => {
  for (const options of [{ externalOperation: true }, { emailFailed: true }]) {
    const { calls, checks } = await probe({ ...options, email: true });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    assert.ok(calls.every(({ url }) => url.hostname !== "other.example.invalid"));
  }
});

test("opt-in Web PubSub probe sends one correlated message using the selected runtime identity", async () => {
  const { calls, checks } = await probe({ webPubSub: true });
  assert.ok(checks.every((check) => check.status === "PASS"));
  assert.equal(checks.filter((check) => check.name === "webpubsub-identity").length, 1);
  assert.equal(checks.filter((check) => check.name === "webpubsub-group-send").length, 1);
  assert.equal(calls.filter(({ url }) => url.hostname === "push.example.invalid").length, 1);
  assert.ok(calls.some(({ url }) => url.hostname === "identity.internal" &&
    url.searchParams.get("resource") === "https://webpubsub.azure.com/"));
});

test("Key Vault probe reads only selected signing-secret metadata using the runtime identity", async () => {
  const { calls, checks } = await probe({ keyVault: true });
  assert.ok(checks.every((check) => check.status === "PASS"));
  assert.equal(checks.filter((check) => check.name === "keyvault-identity").length, 1);
  assert.equal(checks.filter((check) => check.name === "keyvault-signing-metadata").length, 1);
  assert.equal(calls.filter(({ url }) => url.hostname === "demo.vault.example.invalid").length, 1);
  assert.ok(calls.some(({ url }) => url.hostname === "identity.internal" &&
    url.searchParams.get("resource") === "https://vault.azure.net"));
  assert.ok(!JSON.stringify(checks).includes("mcp-signing/abc"));
});

test("Key Vault probe rejects foreign identity, endpoint or metadata and never reads a secret value", async () => {
  for (const options of [{ wrongTenant: true }, { wrongAudience: true }, { invalidVault: true },
    { foreignMetadata: true }, { disabledVersion: true }, { vaultDenied: true }]) {
    const { calls, checks } = await probe({ keyVault: true, ...options });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    const vaultCalls = calls.filter(({ url }) => url.hostname === "demo.vault.example.invalid");
    assert.equal(vaultCalls.length, options.wrongTenant || options.invalidVault ? 0 : 1);
    assert.ok(vaultCalls.every(({ url }) => url.pathname.endsWith("/versions")));
  }
});

test("service profile probe checks scope denial and only safe product-zero tools", async () => {
  const { calls, checks } = await probe({ serviceProfile: true });
  assert.equal(checks.length, 9);
  assert.ok(checks.every((check) => check.status === "PASS"));
  assert.equal(calls.filter(({ url }) => url.hostname === "mcp.example.invalid" && url.pathname === "/token").length, 3);
  assert.equal(calls.filter(({ url }) => url.hostname === "mcp.example.invalid" && url.pathname === "/mcp").length, 2);
  assert.ok(!JSON.stringify(checks).includes("signature"));
});

test("service profile probe reports overbroad grants or tool access without exposing tokens", async () => {
  for (const options of [{ adminGrantAllowed: true }, { manufacturingGrantAllowed: true },
    { serviceToolAllowed: true }, { broadServiceToken: true }, { invalidServiceOrigin: true }, { wrongTenant: true }]) {
    const { calls, checks } = await probe({ serviceProfile: true, ...options });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    assert.ok(!JSON.stringify(checks).includes("must-not-appear-in-evidence"));
    if (options.broadServiceToken || options.invalidServiceOrigin || options.wrongTenant)
      assert.equal(calls.filter(({ url }) => url.pathname === "/mcp").length, 0);
  }
});

test("Web PubSub probe never retries failed sends or sends with an untrusted identity or host", async () => {
  for (const options of [{ webPubSubDenied: true }, { webPubSubNetworkFailure: true },
    { wrongTenant: true }, { invalidWebPubSubHost: true }]) {
    const { calls, checks } = await probe({ webPubSub: true, ...options });
    assert.ok(checks.some((check) => check.status === "FAIL"));
    const sends = calls.filter(({ url }) => url.pathname === "/api/hubs/adventureworks/groups/utilities/:send");
    assert.equal(sends.length, options.wrongTenant || options.invalidWebPubSubHost ? 0 : 1);
  }
});

test("socket receiver rejects foreign capabilities and unrelated group messages", () => {
  const probeId = "12345678-1234-4123-8123-123456789abc";
  const input = {
    host: "push.example.invalid", probeId,
    url: "wss://push.example.invalid/client/hubs/adventureworks?access_token=test-only",
  };
  assert.equal(receiver.validInput(input), true);
  for (const invalid of [
    { ...input, host: "foreign.example.invalid" },
    { ...input, url: input.url.replace("wss:", "https:") },
    { ...input, url: input.url + "&other=value" },
    { ...input, url: input.url.replace("/adventureworks?", "/other?") },
    { ...input, probeId: "not-a-uuid" },
  ]) assert.equal(receiver.validInput(invalid), false);
  const message = { type: "message", from: "group", group: "utilities", dataType: "json",
    data: { event: "auth-assurance-probe", probeId } };
  assert.equal(receiver.matchesMessage(JSON.stringify(message), probeId), true);
  for (const invalid of [
    { ...message, group: "orders" },
    { ...message, from: "server" },
    { ...message, data: { ...message.data, probeId: "other" } },
    { ...message, data: { ...message.data, event: "unrelated" } },
  ]) assert.equal(receiver.matchesMessage(JSON.stringify(invalid), probeId), false);
  assert.equal(receiver.matchesMessage("not json", probeId), false);
});

test("socket receiver accepts only the unique Functions step event", () => {
  const probeId = "12345678-1234-4123-8123-123456789abc";
  const input = {
    host: "push.example.invalid", probeId, kind: "functions-step",
    url: "wss://push.example.invalid/client/hubs/adventureworks?access_token=test-only",
  };
  assert.equal(receiver.validInput(input), true);
  assert.equal(receiver.validInput({ ...input, kind: "arbitrary" }), false);
  const message = { type: "message", from: "group", group: "manufacturing-agent", dataType: "json",
    data: { event: "step-updated", runId: probeId, key: "auth-assurance-" + probeId, status: "started" } };
  assert.equal(receiver.matchesMessage(JSON.stringify(message), probeId, input.kind), true);
  for (const invalid of [
    { ...message, group: "utilities" },
    { ...message, from: "server" },
    { ...message, data: { ...message.data, runId: "other" } },
    { ...message, data: { ...message.data, key: "other" } },
    { ...message, data: { ...message.data, status: "completed" } },
  ]) assert.equal(receiver.matchesMessage(JSON.stringify(invalid), probeId, input.kind), false);
  assert.equal(receiver.matchesMessage(JSON.stringify(message), probeId, "arbitrary"), false);
});

async function fixture(operation, options = {}) {
  const probeId = "12345678-1234-4123-8123-123456789abc";
  const config = {
    operation, expectedStep: options.expectedStep || "present", probeId, enqueuedAt: "2026-01-01T12:00:00Z",
    clientId: "client", principalId: "principal", tenantId: "tenant",
    tableEndpoint: options.foreignPath ? "https://table.example.invalid/not-root" : "https://table.example.invalid/",
  };
  const calls = [];
  let result;
  let row = operation === "cleanup" || operation === "inspect" || options.preexisting ? {
    PartitionKey: "runs", RowKey: "99999999999999999999-" + probeId, RunId: probeId,
    SalesOrderId: 0, CustomerId: 0, Mode: 1, Status: "running",
    EnqueuedAt: config.enqueuedAt, FindingsSummary: "AuthAssuranceFixture:" + probeId,
    StepsJson: options.missingStep ? null : JSON.stringify([{
      key: options.foreignStep ? "another-step" : "auth-assurance-" + probeId,
      label: "Authentication assurance", startedAt: "2026-01-01T12:01:00Z", completedAt: null,
    }]),
  } : null;
  if (row && options.foreignOwner) row.FindingsSummary = "another-fixture";
  const response = (status, document = null) => ({
    status, json: async () => document, headers: { get: (name) => name === "etag" ? 'W/"fixture-etag"' : null },
  });
  await vm.runInNewContext(fixtureSource, {
    globalThis: { authFunctionsPushFixture: config }, URL, Buffer, AbortSignal, require,
    setTimeout: (callback) => { callback(); },
    process: { env: { IDENTITY_ENDPOINT: "http://identity.internal/token", IDENTITY_HEADER: "test-header" },
      exit() {} },
    console: { log: (value) => { result = JSON.parse(value.slice("AUTH_FUNCTIONS_PUSH_FIXTURE:".length)); } },
    fetch: async (target, request) => {
      const url = new URL(target);
      const method = request.method || "GET";
      calls.push({ url, method, headers: request.headers });
      if (url.hostname === "identity.internal") {
        assert.equal(url.searchParams.get("resource"), "https://storage.azure.com/");
        const claims = { oid: options.wrongIdentity ? "other" : "principal", tid: "tenant", appid: "client" };
        return response(200, { access_token: "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature" });
      }
      assert.equal(url.hostname, "table.example.invalid");
      if (method === "POST") {
        assert.equal(url.pathname, "/awManufacturingAgentRuns");
        if (options.uncertainInsert) throw new Error("uncertain insert");
        row = JSON.parse(request.body);
        return response(204);
      }
      if (method === "DELETE") {
        assert.equal(request.headers["If-Match"], 'W/"fixture-etag"');
        row = null;
        return response(204);
      }
      return row ? response(200, row) : response(404);
    },
  });
  return { calls, checks: result.checks, etagSha256: result.etagSha256 };
}

test("Functions fixture inserts once, then conditionally deletes only its exact persisted step", async () => {
  const created = await fixture("create");
  assert.ok(created.checks.every((item) => item.status === "PASS"));
  assert.equal(created.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(created.calls.filter((call) => call.method === "DELETE").length, 0);
  const inspected = await fixture("inspect", { missingStep: true });
  assert.ok(inspected.checks.every((item) => item.status === "PASS"));
  assert.equal(created.etagSha256, inspected.etagSha256);
  const cleaned = await fixture("cleanup");
  assert.ok(cleaned.checks.every((item) => item.status === "PASS"));
  assert.equal(cleaned.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.ok(cleaned.checks.some((item) => item.name === "fixture-absent" && item.status === "PASS"));
});

test("Functions fixture inspection fails if a denied request persisted a step", async () => {
  const inspected = await fixture("inspect");
  assert.ok(inspected.checks.some((item) => item.name === "fixture-no-steps" && item.status === "FAIL"));
  assert.equal(inspected.calls.filter((call) => call.method !== "GET").length, 0);
});

test("Functions fixture never deletes foreign state or inserts over an existing row", async () => {
  for (const options of [{ foreignOwner: true }, { foreignStep: true }, { wrongIdentity: true }]) {
    const result = await fixture("cleanup", options);
    assert.ok(result.checks.some((item) => item.status === "FAIL"));
    assert.equal(result.calls.filter((call) => call.method === "DELETE").length, 0);
  }
  const existing = await fixture("create", { preexisting: true });
  assert.ok(existing.checks.some((item) => item.status === "FAIL"));
  assert.equal(existing.calls.filter((call) => call.method === "POST").length, 0);
});

test("Functions fixture reports missing persistence but still removes its owned row", async () => {
  const result = await fixture("cleanup", { missingStep: true });
  assert.ok(result.checks.some((item) => item.name === "fixture-step-persisted" && item.status === "FAIL"));
  assert.ok(result.checks.some((item) => item.name === "fixture-absent" && item.status === "PASS"));
  assert.equal(result.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("Functions fixture does not retry an uncertain insertion or send to an invalid target", async () => {
  const uncertain = await fixture("create", { uncertainInsert: true });
  assert.ok(uncertain.checks.some((item) => item.status === "FAIL"));
  assert.equal(uncertain.calls.filter((call) => call.method === "POST").length, 1);
  const invalid = await fixture("create", { foreignPath: true });
  assert.ok(invalid.checks.some((item) => item.status === "FAIL"));
  assert.equal(invalid.calls.length, 0);
});
