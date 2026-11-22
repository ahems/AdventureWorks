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
