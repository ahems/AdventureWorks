import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadSource(relativePath, imports = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    URL,
    URLSearchParams,
    require: (name) => {
      if (Object.hasOwn(imports, name)) return imports[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return module.exports;
}

const pagination = loadSource("../src/lib/graphql-pagination.ts");
const language = loadSource("../src/context/LanguageContext.tsx", {
  react: { createContext: () => ({}) },
  "react-i18next": {},
});
const seo = loadSource("../src/components/SEO.tsx", {
  "react-helmet-async": {},
  "@/context/LanguageContext": language,
});

test("fetchAllPages follows DAB cursors until hasNextPage is false", async () => {
  const calls = [];
  const pages = {
    null: { items: [1, 2], hasNextPage: true, endCursor: "c1" },
    c1: { items: [3, 4], hasNextPage: true, endCursor: "c2" },
    c2: { items: [5], hasNextPage: false, endCursor: "c3" },
  };
  const items = await pagination.fetchAllPages(
    async (page) => {
      calls.push({ ...page });
      return { products: pages[String(page.after)] };
    },
    (data) => data.products,
    2,
  );
  assert.deepEqual([...items], [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [
    { first: 2, after: null },
    { first: 2, after: "c1" },
    { first: 2, after: "c2" },
  ]);
});

test("fetchAllPages rejects a repeated cursor instead of looping", async () => {
  await assert.rejects(
    pagination.fetchAllPages(
      async () => ({ items: [1], hasNextPage: true, endCursor: "same" }),
      (data) => data,
    ),
    /repeated cursor/,
  );
});

test("Arabic and Hebrew render right-to-left; other locales left-to-right", () => {
  assert.equal(language.getLanguageDirection("ar"), "rtl");
  assert.equal(language.getLanguageDirection("he"), "rtl");
  assert.equal(language.getLanguageDirection("en-gb"), "ltr");
  assert.equal(language.getLanguageDirection("zh-cht"), "ltr");
});

test("?lang= selects only supported locales", () => {
  assert.equal(language.getRequestedLanguage("?lang=HE"), "he");
  assert.equal(language.getRequestedLanguage("?lang=zh-cht&x=1"), "zh-cht");
  assert.equal(language.getRequestedLanguage("?lang=xx"), null);
  assert.equal(language.getRequestedLanguage(""), null);
});

test("hreflang alternates cover every language plus x-default", () => {
  const alternates = seo.buildHreflangAlternates(
    "https://shop.example/product/7?lang=fr&ref=a#reviews",
  );
  assert.equal(alternates.length, language.LANGUAGES.length + 1);
  const byLang = Object.fromEntries(alternates.map((a) => [a.hrefLang, a.href]));
  assert.equal(byLang.ar, "https://shop.example/product/7?lang=ar&ref=a");
  assert.equal(byLang["x-default"], "https://shop.example/product/7?ref=a");
  assert.deepEqual([...seo.buildHreflangAlternates("not a url")], []);
});

test("product structured data uses the active ISO currency", () => {
  const data = seo.generateProductStructuredData({
    name: "Bike",
    price: 123.456,
    priceCurrency: "EUR",
    sku: "BK-1",
    availability: "InStock",
  });
  assert.equal(data.offers.priceCurrency, "EUR");
  assert.equal(data.offers.price, 123.46);
  assert.equal(
    seo.generateProductStructuredData({
      name: "Bike",
      price: 1,
      priceCurrency: "TRL",
      sku: "BK-1",
      availability: "InStock",
    }).offers.priceCurrency,
    "TRY",
  );
});
