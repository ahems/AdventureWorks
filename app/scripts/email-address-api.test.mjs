import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports, Error, JSON });
  return module.exports;
}

const api = loadSource("../src/lib/emailAddressApi.ts");

function fakeFetch(status, body = { value: [] }) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetcher, calls };
}

test("duplicate email (409) becomes a clear account-conflict message", async () => {
  const { fetcher } = fakeFetch(409);
  await assert.rejects(
    api.createEmailAddress(fetcher, "https://dab.test/api/", 7, "taken@example.com"),
    (error) => error.message === api.DUPLICATE_EMAIL_MESSAGE,
  );
  await assert.rejects(
    api.updateEmailAddress(fetcher, "https://dab.test/api", 7, 3, "taken@example.com"),
    (error) => error.message === api.DUPLICATE_EMAIL_MESSAGE,
  );
});

test("create and update use owner-scoped DAB REST routes and return the saved row", async () => {
  const saved = { EmailAddressID: 3, BusinessEntityID: 7, EmailAddress: "new@example.com" };
  const { fetcher, calls } = fakeFetch(201, { value: [saved] });
  assert.deepEqual(
    await api.createEmailAddress(fetcher, "https://dab.test/api/", 7, " new@example.com "),
    saved,
  );
  assert.equal(calls[0].url, "https://dab.test/api/EmailAddress");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    BusinessEntityID: 7,
    EmailAddress: "new@example.com",
  });

  await api.updateEmailAddress(fetcher, "https://dab.test/api", 7, 3, "new@example.com");
  assert.equal(
    calls[1].url,
    "https://dab.test/api/EmailAddress/BusinessEntityID/7/EmailAddressID/3",
  );
  assert.equal(calls[1].init.method, "PATCH");
});

test("other failures are not reported as duplicates", async () => {
  const { fetcher } = fakeFetch(500);
  await assert.rejects(
    api.updateEmailAddress(fetcher, "https://dab.test/api", 7, 3, "x@example.com"),
    (error) => error.message !== api.DUPLICATE_EMAIL_MESSAGE && /500/.test(error.message),
  );
});
