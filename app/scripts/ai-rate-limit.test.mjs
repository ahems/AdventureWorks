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
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    Error,
    Number,
    Math,
  });
  return module.exports;
}

const limits = loadSource("../src/lib/aiRateLimit.ts");
const response = (status, retryAfter) => ({
  status,
  headers: { get: (name) => (name === "Retry-After" ? retryAfter : null) },
});

test("429 responses become AiRateLimitError with the Retry-After delay", () => {
  assert.doesNotThrow(() => limits.throwIfAiRateLimited(response(500, null)));
  assert.throws(
    () => limits.throwIfAiRateLimited(response(429, "150")),
    (error) =>
      limits.isAiRateLimitError(error) &&
      error.retryAfterSeconds === 150 &&
      limits.retryAfterMinutes(error) === 3,
  );
  assert.throws(
    () => limits.throwIfAiRateLimited(response(429, "soon")),
    (error) =>
      error.retryAfterSeconds === null && limits.retryAfterMinutes(error) === 1,
  );
});

test("React Query never retries a rate-limited AI request", () => {
  const retry = limits.retryUnlessRateLimited(3);
  assert.equal(retry(0, new Error("network")), true);
  assert.equal(retry(3, new Error("network")), false);
  assert.equal(retry(0, new limits.AiRateLimitError(60)), false);
});

test("every storefront locale has the AI rate-limit messages", () => {
  const locales = [
    "ar",
    "de",
    "en",
    "en-au",
    "en-ca",
    "en-gb",
    "en-ie",
    "en-nz",
    "es",
    "fr",
    "he",
    "id",
    "it",
    "ja",
    "ko",
    "nl",
    "pt",
    "ru",
    "th",
    "tr",
    "vi",
    "zh",
    "zh-cht",
  ];
  for (const locale of locales) {
    const read = (file) =>
      JSON.parse(
        readFileSync(
          new URL(`../src/locales/${locale}/${file}`, import.meta.url),
          "utf8",
        ),
      );
    assert.match(
      read("helpme.json").error.rateLimited,
      /\{\{minutes\}\}/,
      locale,
    );
    assert.match(
      read("common.json").search.aiRateLimited,
      /\{\{minutes\}\}/,
      locale,
    );
  }
});
