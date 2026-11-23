import assert from "node:assert/strict";
import test from "node:test";
import { allSitesVerified, summarizeEnvelopes, trackedEnvelopes } from "./test-frontend-telemetry.mjs";

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

test("deployment verification rejects missing, duplicate, partial or misattributed browser evidence", () => {
  const sites = ["app-eshop", "app-admin", "app-manufacturing"].map(role =>
    ({ role, accepted: 2, items: 2, roleMatches: true }));
  assert.equal(allSitesVerified(sites), true);
  assert.equal(allSitesVerified(sites.slice(0, 2)), false);
  assert.equal(allSitesVerified([sites[0], sites[0], sites[2]]), false);
  for (const failure of [{ accepted: 0 }, { accepted: 1 }, { roleMatches: false }, { error: "timeout" }]) {
    assert.equal(allSitesVerified([{ ...sites[0], ...failure }, ...sites.slice(1)]), false);
  }
});
