(async () => {
  const c = globalThis.seedSqlConfig;
  const checks = [];
  let phase = "configuration";
  try {
    const endpoint = new URL(c.endpoint);
    if (!/^[a-z0-9]{3,24}$/.test(c.account) || !/^[a-z0-9.-]+$/.test(c.suffix) ||
        !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(c.share) || c.share.includes("--") ||
        endpoint.protocol !== "https:" || endpoint.hostname !== c.account + ".file." + c.suffix ||
        endpoint.pathname !== "/" || endpoint.port || endpoint.search || endpoint.hash ||
        endpoint.username || endpoint.password)
      throw new Error("storage-target");
    const start = Date.parse(c.start), end = Date.parse(c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 86400000)
      throw new Error("execution-time");

    phase = "identity";
    const identity = new URL(process.env.IDENTITY_ENDPOINT);
    if (identity.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(identity.hostname) ||
        identity.username || identity.password || identity.hash || !process.env.IDENTITY_HEADER)
      throw new Error("identity-endpoint");
    identity.searchParams.set("api-version", "2019-08-01");
    identity.searchParams.set("resource", "https://storage.azure.com/");
    identity.searchParams.set("client_id", c.clientId);
    const tokenResponse = await fetch(identity, {
      headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    if (tokenResponse.status !== 200) throw new Error("identity-status");
    const accessToken = (await tokenResponse.json()).access_token;
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    if (claims.oid?.toLowerCase() !== c.principalId || claims.tid?.toLowerCase() !== c.tenantId ||
        (claims.azp ?? claims.appid)?.toLowerCase() !== c.clientId)
      throw new Error("identity-binding");
    const headers = {
      Authorization: "Bearer " + accessToken,
      "x-ms-version": "2024-11-04",
      "x-ms-file-request-intent": "backup",
    };

    phase = "list";
    const names = [];
    const days = new Set([new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)]);
    for (const day of days) {
      const list = new URL(c.share, endpoint);
      list.searchParams.set("restype", "directory");
      list.searchParams.set("comp", "list");
      list.searchParams.set("maxresults", "100");
      list.searchParams.set("prefix", "seed-" + day.replaceAll("-", ""));
      const listed = await fetch(list, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
      if (listed.status !== 200) throw new Error("listing-status");
      const xml = await listed.text();
      if (Buffer.byteLength(xml, "utf8") > 200000) throw new Error("listing-too-large");
      const marker = xml.match(/<NextMarker(?:\s*\/>|>([^<]*)<\/NextMarker>)/);
      if (!marker || marker[1]) throw new Error("listing-not-complete");
      for (const match of xml.matchAll(
        /<File>\s*<Name>(seed-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log)<\/Name>/g
      )) {
        const stamp = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}`;
        const time = Date.parse(stamp + "Z");
        if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === stamp &&
            time >= Math.floor(start / 1000) * 1000 && time <= Math.ceil(end / 1000) * 1000)
          names.push(match[1]);
      }
    }
    if (names.length !== 1) throw new Error("seed-log-match-count");

    phase = "read";
    const file = new URL(c.share + "/" + names[0], endpoint);
    const response = await fetch(file, {
      headers: { ...headers, Range: "bytes=0-65535" },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    const size = Number(response.headers.get("content-length"));
    if (![200, 206].includes(response.status) || !Number.isInteger(size) || size < 1 || size > 65536)
      throw new Error("file-size");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") !== size) throw new Error("file-length");
    const expectations = [
      "DATABASE SEEDING SCRIPT STARTED",
      "Seed script version: " + c.scriptVersion,
      "Environment variables:",
      "SQL Server: " + c.sqlServer,
      "SQL Database: " + c.sqlDatabase,
      "Managed Identity: " + c.seedName,
      "Tenant ID: " + c.tenantId,
      "Client ID: " + c.seedClient,
      "Successfully connected to Azure using Managed Identity",
      "Obtained Azure AD access token for SQL using Managed Identity",
      "Successfully connected to SQL Database",
    ];
    let offset = 0;
    for (const value of expectations) {
      const index = text.indexOf(value, offset);
      if (index < 0) throw new Error("seed-markers-incomplete");
      offset = index + value.length;
    }
    checks.push({ name: "seed-sql-log", status: "PASS", phase, detail: "Correlated log markers were observed." });
  } catch {
    checks.push({ name: "seed-sql-log", status: "BLOCKED", phase,
      detail: "Read-only seed log correlation was unavailable at " + phase + "; contents withheld." });
  }
  console.log("AUTH_SEED_SQL_RESULT:" + JSON.stringify({ checks }));
  setTimeout(() => process.exit(0), 1000);
})();
