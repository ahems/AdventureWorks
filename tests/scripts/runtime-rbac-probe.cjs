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
    if (config.keyVault) {
      phase = "keyvault";
      const { uri, certificate } = config.keyVault;
      const endpoint = new URL(uri);
      if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.port ||
          endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
          !/^[a-z0-9-]+\.vault\.[a-z0-9.-]+$/.test(endpoint.hostname) ||
          !/^[A-Za-z0-9-]{1,127}$/.test(certificate))
        throw new Error("keyvault-configuration");
      const vaultToken = await token("https://vault.azure.net");
      const claims = JSON.parse(Buffer.from(vaultToken.split(".")[1], "base64url").toString());
      const tenantMatches = claims.tid === config.tenantId;
      const clientMatches = (claims.azp ?? claims.appid) === config.clientId;
      requireCheck("keyvault-identity", tenantMatches && clientMatches,
        "Key Vault token binding checks: tenant=" + tenantMatches +
        ", client=" + clientMatches + "; audience requires a successful Key Vault request");
      const versions = new URL("/secrets/" + encodeURIComponent(certificate) + "/versions?api-version=7.4", endpoint);
      const metadata = await request(versions, { headers: { Authorization: "Bearer " + vaultToken } });
      const document = metadata.status === 200 ? await metadata.json() : null;
      const prefix = new URL("/secrets/" + encodeURIComponent(certificate) + "/", endpoint).href;
      requireCheck("keyvault-signing-metadata", metadata.status === 200 && Array.isArray(document?.value) &&
        document.value.some((item) => typeof item?.id === "string" && item.id.startsWith(prefix) &&
          /^[A-Za-z0-9-]+$/.test(item.id.slice(prefix.length)) && item.attributes?.enabled === true),
      "Selected runtime UAMI must read enabled signing-secret version metadata without requesting its value; HTTP " +
        metadata.status);
    }
    if (config.serviceProfile) {
      phase = "service-profile";
      const endpoint = new URL(config.serviceProfile.origin);
      if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
          endpoint.username || endpoint.password)
        throw new Error("service-profile-origin");
      const origin = endpoint.origin;
      const assertion = await token("api://AzureADTokenExchange");
      const asserted = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      requireCheck("service-profile-identity",
        asserted.tid === config.tenantId && (asserted.azp ?? asserted.appid) === config.clientId &&
        ["api://AzureADTokenExchange", "fb60f99c-7a34-4190-8149-302f77469936"].includes(asserted.aud),
        "The existing admin container uses the selected shared runtime UAMI for the Entra exchange.");

      const exchange = async (scope) => {
        const response = await request(origin + "/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "urn:adventureworks:params:oauth:grant-type:managed-identity",
            client_id: "adventureworks-agents", assertion, resource: origin + "/mcp", scope,
          }),
        });
        return { status: response.status, body: await response.json() };
      };
      const read = await exchange("mcp.access products.read");
      const access = read.body.access_token;
      const issued = typeof access === "string"
        ? JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()) : null;
      requireCheck("service-profile-catalogue-grant",
        read.status === 200 && read.body.token_type === "Bearer" &&
        issued?.iss === origin + "/" && issued?.aud === origin + "/mcp" &&
        issued?.sub === "service:" + config.principalId && issued?.category === "service" &&
        issued?.app === "adventureworks-agents" && typeof issued?.scope === "string" &&
        issued.scope.split(" ").sort().join(" ") === "mcp.access products.read" &&
        typeof issued.exp === "number" && issued.exp > Date.now() / 1000,
        "The shared runtime principal receives only the requested catalogue scopes.");

      for (const [name, scope] of [
        ["service-profile-admin-denied", "mcp.access mcp.admin"],
        ["service-profile-manufacturing-write-denied", "mcp.access manufacturing.write"],
      ]) {
        const denied = await exchange(scope);
        checks.push({ name,
          status: denied.status === 400 && denied.body.error === "invalid_scope" &&
            !Object.hasOwn(denied.body, "access_token") ? "PASS" : "FAIL",
          detail: "Expected invalid_scope and no token; observed HTTP " + denied.status + "." });
      }

      const callTool = async (name) => {
        const response = await request(origin + "/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer " + access, "Content-Type": "application/json",
            Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name, arguments: { productId: 0 } } }),
        });
        let raw = await response.text();
        if (raw.length > 65536) throw new Error("service-profile-response-size");
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
          const lines = raw.split("\n").filter((line) => line.startsWith("data: "));
          if (lines.length !== 1) throw new Error("service-profile-events");
          raw = lines[0].slice(6);
        }
        return { status: response.status, body: JSON.parse(raw) };
      };
      const allowed = await callTool("get_product_details");
      requireCheck("service-profile-catalogue-tool", allowed.status === 200 && !allowed.body.error &&
        allowed.body.result?.isError !== true &&
        allowed.body.result?.content?.[0]?.text === "Product ID 0 not found",
        "The allowed read-only catalogue tool handles the absent product 0.");
      const denied = await callTool("get_product_availability");
      checks.push({ name: "service-profile-tool-denied",
        status: denied.status === 200 && !denied.body.error && denied.body.result?.isError === true &&
          denied.body.result?.content?.[0]?.text === "This service is not authorized to call this tool."
          ? "PASS" : "FAIL",
        detail: "The read-only availability tool is denied despite its matching catalogue scope." });
    }
    if (config.webPubSub) {
      phase = "webpubsub";
      const { host, probeId } = config.webPubSub;
      const endpoint = new URL("https://" + host);
      if (endpoint.hostname !== host || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
          endpoint.username || endpoint.password ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(probeId))
        throw new Error("webpubsub-configuration");
      const pubsubToken = await token("https://webpubsub.azure.com/");
      const claims = JSON.parse(Buffer.from(pubsubToken.split(".")[1], "base64url").toString());
      requireCheck("webpubsub-identity",
        claims.tid === config.tenantId && (claims.azp ?? claims.appid) === config.clientId,
        "Web PubSub token matches the selected runtime principal, client and tenant");
      const send = await request(new URL("/api/hubs/adventureworks/groups/utilities/:send?api-version=2024-12-01", endpoint), {
        method: "POST",
        headers: { Authorization: "Bearer " + pubsubToken, "Content-Type": "application/json" },
        body: JSON.stringify({ event: "auth-assurance-probe", probeId }),
      });
      requireCheck("webpubsub-group-send", send.status === 202,
        "One opt-in nonpersistent utilities-group message; expected HTTP 202, received " + send.status);
    }
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
