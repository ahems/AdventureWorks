(async () => {
  const config = globalThis.authRbacConfig;
  const checks = [];
  let phase = "configuration";
  const requireCheck = (name, condition, detail) => {
    checks.push({ name, status: condition ? "PASS" : "FAIL", detail });
    if (!condition) throw new Error("assertion");
  };
  const request = (url, options = {}) => fetch(url, {
    ...options, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const token = async (resource) => {
    const url = new URL(process.env.IDENTITY_ENDPOINT);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", resource);
    url.searchParams.set("client_id", config.clientId);
    const response = await request(url, { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } });
    if (response.status !== 200) throw new Error("managed-identity");
    const document = await response.json();
    const claims = JSON.parse(Buffer.from(document.access_token.split(".")[1], "base64url").toString());
    if (claims.oid !== config.principalId) throw new Error("wrong-identity");
    return document.access_token;
  };
  try {
    if (!config || !config.clientId || !config.principalId) throw new Error("configuration");
    phase = "runtime-management-denials";
    const armToken = await token("https://management.azure.com/");
    for (const [name, id, version] of [
      ["storage-management-denied", config.storageId, "2025-06-01"],
      ["acr-management-denied", config.acrId, "2023-07-01"],
    ]) {
      const response = await request("https://management.azure.com" + id + "?api-version=" + version,
        { headers: { Authorization: "Bearer " + armToken } });
      requireCheck(name, response.status === 403, "Expected HTTP 403; received " + response.status);
    }
    phase = "acr-pull";
    const acrToken = await token("https://containerregistry.azure.net");
    let response = await request("https://" + config.registry + "/oauth2/exchange", {
      method: "POST", body: new URLSearchParams({
        grant_type: "access_token", service: config.registry, tenant: config.tenantId, access_token: acrToken,
      }),
    });
    if (response.status !== 200) throw new Error("acr-exchange");
    const exchange = await response.json();
    response = await request("https://" + config.registry + "/oauth2/token", {
      method: "POST", body: new URLSearchParams({
        grant_type: "refresh_token", service: config.registry,
        scope: "repository:" + config.repository + ":pull", refresh_token: exchange.refresh_token,
      }),
    });
    if (response.status !== 200) throw new Error("acr-repository-token");
    const repository = await response.json();
    response = await request("https://" + config.registry + "/v2/" + config.repository + "/manifests/" + config.tag, {
      headers: { Authorization: "Bearer " + repository.access_token,
        Accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json" },
    });
    const manifest = response.status === 200 ? await response.json() : null;
    requireCheck("acr-manifest-pull", response.status === 200 && manifest?.schemaVersion === 2,
      "Existing runtime UAMI fetched the actual deployed image manifest with repository pull authorization");
    if (config.recipient) {
      phase = "email-send";
      const endpoint = new URL(config.communicationEndpoint);
      if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
        throw new Error("communication-endpoint");
      const emailToken = await token("https://communication.azure.com");
      const operationId = require("node:crypto").randomUUID();
      const send = await request(new URL("/emails:send?api-version=2023-03-31", endpoint), {
        method: "POST", headers: { Authorization: "Bearer " + emailToken, "Content-Type": "application/json",
          "Operation-Id": operationId },
        body: JSON.stringify({
          senderAddress: "DoNotReply@" + config.senderDomain,
          recipients: { to: [{ address: config.recipient }] },
          content: { subject: "AdventureWorks managed-identity email verification",
            plainText: "Controlled authentication verification. This message was sent using the application's managed identity after removal of Contributor. No order was created." },
        }),
      });
      requireCheck("email-send-authorized", send.status === 202, "Expected HTTP 202; received " + send.status);
      const location = new URL(send.headers.get("operation-location"), endpoint);
      if (location.origin !== endpoint.origin || !location.pathname.startsWith("/emails/operations/"))
        throw new Error("email-operation-origin");
      phase = "email-operation";
      let completed = false;
      for (let count = 0; count < 36; count++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const status = await request(location, { headers: { Authorization: "Bearer " + emailToken } });
        if (status.status !== 200) throw new Error("email-operation-http");
        const document = await status.json();
        if (document.status === "Succeeded") { completed = true; break; }
        if (["Failed", "Canceled"].includes(document.status)) break;
      }
      requireCheck("email-operation-succeeded", completed,
        "Azure completed the approved test email operation; mailbox delivery is not independently asserted");
    }
  } catch (error) {
    if (!checks.some((check) => check.status === "FAIL"))
      checks.push({ name: phase, status: "FAIL", detail: "Runtime probe failed; response bodies and credentials withheld" });
  }
  console.log("AUTH_RUNTIME_RBAC_RESULT:" + JSON.stringify({ checks }));
  setTimeout(() => process.exit(checks.some((check) => check.status === "FAIL") ? 1 : 0), 1000);
})();
