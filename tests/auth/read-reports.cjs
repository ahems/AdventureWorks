(async () => {
  const { createHash } = require("node:crypto");
  const config = globalThis.authReportConfig;
  const checks = [];
  try {
    if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(config.runId) ||
        config.prefix !== "auth-assurance/" + config.runId + "/")
      throw new Error("InvalidRunPrefix");
    const identity = new URL(process.env.IDENTITY_ENDPOINT);
    identity.search = new URLSearchParams({
      resource: "https://storage.azure.com/", "api-version": "2019-08-01", client_id: config.clientId,
    });
    const response = await fetch(identity, {
      headers: { "X-Identity-Header": process.env.IDENTITY_HEADER }, redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 200) throw new Error("IdentityEndpointDenied");
    const token = (await response.json()).access_token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (claims.oid !== config.principalId || claims.tid !== config.tenantId)
      throw new Error("UnexpectedRuntimeIdentity");
    checks.push({ name: "runtime-identity", status: "PASS" });
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== "/")
      throw new Error("InvalidStorageEndpoint");
    const read = async (name, maximum) => {
      const url = new URL("adventureworks-receipts/" + config.prefix + name, endpoint);
      const result = await fetch(url, { headers: {
        Authorization: "Bearer " + token, "x-ms-version": "2023-11-03",
      }, redirect: "error", signal: AbortSignal.timeout(30000) });
      if (result.status !== 200) throw new Error("ReportBlobReadDenied");
      const declared = Number(result.headers.get("content-length"));
      if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximum)
        throw new Error("ReportBlobSizeOutOfBounds");
      const chunks = [];
      let length = 0;
      for await (const chunk of result.body) {
        length += chunk.length;
        if (length > maximum) throw new Error("ReportBlobSizeOutOfBounds");
        chunks.push(chunk);
      }
      if (length !== declared) throw new Error("ReportBlobLengthMismatch");
      return Buffer.concat(chunks);
    };
    const manifest = JSON.parse((await read("artifacts.json", 16384)).toString("utf8"));
    const names = ["report.pdf", "report.html", "report.json", "junit.xml"];
    if (Object.keys(manifest).sort().join() !== [...names].sort().join())
      throw new Error("InvalidReportManifest");
    let total = 0;
    for (const name of names) {
      const entry = manifest[name];
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
          !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("InvalidReportManifest");
      total += entry.bytes;
    }
    if (total > 1024 * 1024) throw new Error("ReportTransferExceedsReviewedBound");
    const artifacts = {};
    for (const name of names) {
      const data = await read(name, manifest[name].bytes);
      if (createHash("sha256").update(data).digest("hex") !== manifest[name].sha256)
        throw new Error("ReportChecksumMismatch");
      artifacts[name] = { ...manifest[name], content: data.toString("base64") };
    }
    checks.push({ name: "report-readback", status: "PASS" });
    console.log("AUTH_ASSURANCE_DOWNLOAD_RESULT:" + JSON.stringify({
      checks, runId: config.runId, prefix: config.prefix, artifacts,
    }));
    process.exit(0);
  } catch (error) {
    checks.push({ name: "report-readback", status: "FAIL",
      detail: "Read-only report recovery failed; raw diagnostics withheld." });
    console.log("AUTH_ASSURANCE_DOWNLOAD_RESULT:" + JSON.stringify({ checks }));
    process.exit(1);
  }
})();
