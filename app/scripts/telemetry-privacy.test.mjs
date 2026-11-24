import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoots = ["app/src", "app-admin/src", "app-manufacturing/src"];
const telemetryCalls = new Set([
  "trackEvent",
  "trackError",
  "trackException",
  "trackTrace",
  "trackMetric",
]);
const personalDataProperty =
  /^(e-?mail|emailaddress|(first|last|full|middle|user|display)name|phone(number)?|password)$/i;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__")
        yield* sourceFiles(path);
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(test|spec)\.tsx?$/.test(entry)
    ) {
      yield path;
    }
  }
}

function propertyName(node) {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  if (ts.isPropertyAssignment(node) && node.name) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      return node.name.text;
  }
  return null;
}

function findPersonalDataInTelemetry(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null;
      if (callee && telemetryCalls.has(callee)) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            const name = propertyName(prop);
            if (name && personalDataProperty.test(name)) {
              const { line } = source.getLineAndCharacterOfPosition(
                prop.getStart(),
              );
              findings.push(
                `${relative(repoRoot, file)}:${line + 1} ${callee} → ${name}`,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

test("frontend telemetry calls never send email, name, phone or password properties", () => {
  const findings = sourceRoots.flatMap((root) =>
    [...sourceFiles(join(repoRoot, root))].flatMap(findPersonalDataInTelemetry),
  );
  assert.deepEqual(findings, []);
});

test("storefront sign-in and sign-up events identify users only by BusinessEntityID", () => {
  const file = join(repoRoot, "app/src/context/AuthContext.tsx");
  const text = readFileSync(file, "utf8");
  for (const event of ["User_Login", "User_Signup"]) {
    const match = text.match(
      new RegExp(`trackEvent\\("${event}",\\s*\\{([^}]*)\\}`),
    );
    assert.ok(match, `${event} event not found`);
    const keys = match[1]
      .split(",")
      .map((part) => part.split(":")[0].trim())
      .filter(Boolean);
    assert.deepEqual(keys, ["userId"]);
  }
});

for (const root of ["app", "app-admin", "app-manufacturing"]) {
  test(`${root} outbound sanitizer removes nested/serialized credentials, error text and URL secrets`, async () => {
    const source = readFileSync(join(repoRoot, root, "src/lib/telemetrySafety.ts"), "utf8");
    const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    const { sanitizeTelemetry, classifyFailure, routeTemplate } = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString("base64")}`);
    const marker = "privateMarker";
    const payload = {
      baseData: { name: "GET /api/orders/123?code=privateMarker", url: `https://name:${marker}@example.test/oauth/callback?state=${marker}#${marker}`,
        properties: {
          nested: { authorization: `Bearer ${marker}`, apiKey: marker, accessKey: marker, connectionString: marker, cookies: marker, error: { detail: marker }, headers: { Authorization: marker } },
          serialized: JSON.stringify({ nested: { password: marker, request: `/graphql?query=${marker}`, errors: [{ message: marker }] } }),
          exception: new Error(marker),
          detail: `GET /reset-password?token=${marker}`,
        } },
    };
    const safe = JSON.stringify(sanitizeTelemetry(payload));
    assert.ok(!safe.includes(marker), safe);
    assert.equal(routeTemplate("/api/orders/123?password=x"), "/api/orders/:id");
    assert.equal(classifyFailure({ response: { status: 200, errors: [{}] } }), "graphql-error");
    assert.equal(classifyFailure({ name: "AbortError" }), "cancelled");
    assert.equal(classifyFailure({ message: "The session has changed." }), "authorization-cancelled");
    assert.equal(classifyFailure({ status: 429 }), "throttled");
    const tags = [{ "ai.operation.name": "/api/orders/123?token=privateMarker" }];
    tags["ai.cloud.role"] = root;
    tags.authorization = "Bearer privateMarker";
    Object.defineProperty(tags, "__proto__", { value: { password: marker }, enumerable: true });
    const safeTags = sanitizeTelemetry({ tags }).tags;
    assert.ok(Array.isArray(safeTags));
    assert.equal(safeTags["ai.cloud.role"], root);
    assert.equal(safeTags.authorization, "[redacted]");
    assert.equal(Object.getPrototypeOf(safeTags), Array.prototype);
    assert.equal(safeTags.__proto__.password, "[redacted]");
    assert.equal(safeTags[0]["ai.operation.name"], "/api/orders/:id");
    const startTime = new Date("2026-01-01T00:00:00.000Z");
    const safeDependency = sanitizeTelemetry({ baseData: { startTime } });
    assert.ok(safeDependency.baseData.startTime instanceof Date);
    assert.equal(safeDependency.baseData.startTime.toISOString(), startTime.toISOString());
  });
}
