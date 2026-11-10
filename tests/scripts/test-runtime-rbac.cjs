const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(require("node:path").join(__dirname, "runtime-rbac-probe.cjs"), "utf8");

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
  const response = (status, document = {}, location = null) => ({
    status, json: async () => document, headers: { get: () => location },
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
        const claims = { oid: options.wrongIdentity ? "other-principal" : config.principalId };
        return response(200, { access_token: "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature" });
      }
      if (url.hostname === "management.azure.com") return response(options.managementAllowed ? 200 : 403);
      if (url.pathname === "/oauth2/exchange") return response(200, { refresh_token: "test-refresh" });
      if (url.pathname === "/oauth2/token") {
        assert.equal(request.body.get("scope"), "repository:admin:pull");
        return response(200, { access_token: "test-repository" });
      }
      if (url.pathname === "/v2/admin/manifests/deployed") return response(200, { schemaVersion: 2 });
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
