import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEnvelopes, trackedEnvelopes } from "./test-frontend-telemetry.mjs";

const envelope = (role, operation = "a".repeat(32)) =>
  ({ tags: { "ai.cloud.role": role, "ai.operation.id": operation } });

test("parses JSON-array and newline-delimited track payloads", () => {
  assert.equal(trackedEnvelopes(JSON.stringify([envelope("app-admin"), envelope("app-admin")])).length, 2);
  assert.equal(trackedEnvelopes(`${JSON.stringify(envelope("app-admin"))}\n${JSON.stringify(envelope("x"))}\n`).length, 2);
  assert.deepEqual(trackedEnvelopes(null), []);
});

test("requires every envelope to carry only the site's own role", () => {
  assert.deepEqual(summarizeEnvelopes([envelope("app-admin")], "app-admin"),
    { items: 1, roleMatches: true, operationIds: ["a".repeat(32)] });
  assert.equal(summarizeEnvelopes([envelope("app-admin"), envelope("app-eshop")], "app-admin").roleMatches, false);
  assert.equal(summarizeEnvelopes([], "app-admin").roleMatches, false);
  assert.deepEqual(summarizeEnvelopes([envelope("app-admin", "not-an-id")], "app-admin").operationIds, []);
});
