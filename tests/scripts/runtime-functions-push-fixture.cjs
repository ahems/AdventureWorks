(async () => {
  const config = globalThis.authFunctionsPushFixture;
  const checks = [];
  let etagSha256 = null;
  let phase = "configuration";
  const check = (name, condition, detail) => {
    checks.push({ name, status: condition ? "PASS" : "FAIL", detail });
    if (!condition) throw new Error("assertion");
  };
  const request = (url, options = {}) => fetch(url, {
    ...options, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!config || !uuid.test(config.probeId) || !["create", "inspect", "cleanup"].includes(config.operation) ||
        (config.operation === "cleanup" && !["present", "unknown"].includes(config.expectedStep)) ||
        typeof config.enqueuedAt !== "string" || Number.isNaN(Date.parse(config.enqueuedAt)) ||
        !config.clientId || !config.principalId || !config.tenantId)
      throw new Error("configuration");
    const endpoint = new URL(config.tableEndpoint);
    if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
        endpoint.username || endpoint.password)
      throw new Error("table-endpoint");
    const rowKey = "99999999999999999999-" + config.probeId;
    const marker = "AuthAssuranceFixture:" + config.probeId;
    const stepKey = "auth-assurance-" + config.probeId;
    const identity = new URL(process.env.IDENTITY_ENDPOINT);
    identity.searchParams.set("api-version", "2019-08-01");
    identity.searchParams.set("resource", "https://storage.azure.com/");
    identity.searchParams.set("client_id", config.clientId);
    phase = "identity";
    const tokenResponse = await request(identity, {
      headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER },
    });
    if (tokenResponse.status !== 200) throw new Error("managed-identity");
    const token = (await tokenResponse.json()).access_token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    check("fixture-identity", claims.oid === config.principalId && claims.tid === config.tenantId &&
      (claims.azp ?? claims.appid) === config.clientId,
    "Table access uses the selected shared runtime identity");
    const headers = () => ({
      Authorization: "Bearer " + token,
      Accept: "application/json;odata=nometadata",
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": "2019-02-02",
      DataServiceVersion: "3.0",
      MaxDataServiceVersion: "3.0",
    });
    const table = new URL("/awManufacturingAgentRuns", endpoint);
    const entity = new URL("/awManufacturingAgentRuns(PartitionKey='runs',RowKey='" + rowKey + "')", endpoint);
    const read = () => request(entity, { headers: headers() });
    const owned = (row) => row.PartitionKey === "runs" && row.RowKey === rowKey &&
      row.RunId === config.probeId && row.SalesOrderId === 0 && row.CustomerId === 0 &&
      row.Mode === 1 && row.Status === "running" && row.FindingsSummary === marker &&
      Date.parse(row.EnqueuedAt) === Date.parse(config.enqueuedAt) &&
      [row.StartedAt, row.CompletedAt, row.ToolsUsed, row.ProposalIds, row.ActionsExecuted,
        row.RetryAfterUtc, row.LastError].every((value) => value == null) &&
      (row.RetryCount == null || row.RetryCount === 0);
    const recordEtag = (response) => {
      const etag = response.headers.get("etag");
      check("fixture-baseline-etag", typeof etag === "string" && etag.length > 0 && etag !== "*",
        "An exact fixture ETag is available for unchanged-state comparison");
      etagSha256 = require("node:crypto").createHash("sha256").update(etag).digest("hex");
    };

    phase = "fixture-read";
    let response = await read();
    if (config.operation === "create") {
      check("fixture-absent-before", response.status === 404,
        "The exact randomly named application fixture did not already exist");
      phase = "fixture-insert";
      response = await request(table, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json", Prefer: "return-no-content" },
        body: JSON.stringify({
          PartitionKey: "runs", RowKey: rowKey, RunId: config.probeId,
          SalesOrderId: 0, CustomerId: 0, Mode: 1, Status: "running",
          "EnqueuedAt@odata.type": "Edm.DateTime", EnqueuedAt: config.enqueuedAt,
          FindingsSummary: marker,
        }),
      });
      check("fixture-created", response.status === 201 || response.status === 204,
        "One run-owned fixture row was inserted without creating a queue message");
      phase = "fixture-confirm";
      response = await read();
      const row = response.status === 200 ? await response.json() : null;
      check("fixture-confirmed", row !== null && owned(row),
        "The exact fixture and ownership marker are readable before the callback");
      recordEtag(response);
    } else if (config.operation === "inspect") {
      const row = response.status === 200 ? await response.json() : null;
      check("fixture-owned", row !== null && owned(row), "The fixture still belongs to this run");
      const steps = row.StepsJson == null ? [] : JSON.parse(row.StepsJson);
      check("fixture-no-steps", Array.isArray(steps) && steps.length === 0,
        "Denied requests did not persist a step");
      recordEtag(response);
    } else if (response.status === 404) {
      checks.push({ name: "fixture-absent", status: "PASS", detail: "The exact fixture row is absent" });
    } else {
      const row = response.status === 200 ? await response.json() : null;
      check("fixture-owned", row !== null && owned(row),
        "Cleanup is restricted to the unchanged, run-owned fixture");
      let steps;
      try {
        steps = row.StepsJson == null ? [] : JSON.parse(row.StepsJson);
      } catch {
        throw new Error("invalid-steps");
      }
      const expected = (step) => step && step.key === stepKey &&
        step.label === "Authentication assurance" && typeof step.startedAt === "string" &&
        !Number.isNaN(Date.parse(step.startedAt)) && step.completedAt == null;
      check("fixture-safe-to-delete", Array.isArray(steps) && steps.length <= 1 && steps.every(expected),
        "No unrelated step or state is removed");
      if (config.expectedStep === "present") {
        checks.push({
          name: "fixture-step-persisted",
          status: steps.length === 1 ? "PASS" : "FAIL",
          detail: "The real Functions callback must persist the unique started step",
        });
      }
      const etag = response.headers.get("etag");
      check("fixture-etag", typeof etag === "string" && etag.length > 0 && etag !== "*",
        "Cleanup uses the exact current entity ETag");
      phase = "fixture-delete";
      response = await request(entity, { method: "DELETE", headers: { ...headers(), "If-Match": etag } });
      check("fixture-deleted", response.status === 204,
        "Only the matching fixture row was conditionally deleted");
      phase = "fixture-verify-absent";
      response = await read();
      check("fixture-absent", response.status === 404, "The exact fixture row is absent after cleanup");
    }
  } catch {
    if (!checks.some((item) => item.status === "FAIL"))
      checks.push({ name: phase, status: "FAIL", detail: "Fixture operation failed; response bodies and credentials withheld" });
  }
  console.log("AUTH_FUNCTIONS_PUSH_FIXTURE:" + JSON.stringify({ checks, etagSha256 }));
  setTimeout(() => process.exit(checks.some((item) => item.status === "FAIL") ? 1 : 0), 1000);
})();
