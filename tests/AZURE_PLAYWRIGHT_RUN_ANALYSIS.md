# Azure Playwright Test Run Analysis

After implementing the plan (env export, sale-discounts timeout, productHelper retries, re-enabled internationalization, ai-features fail-vs-skip), the test suite was re-run. This document summarizes the outcome and remaining issues.

---

## Latest run (after health fix)

**Result: Health check passed; tests ran. 73 passed, 6 failed, 4 flaky.**

- **Health:** All 9 services healthy in **6.1s**. No timeout.
- **Summary:** 73 passed (5.5m) | 6 failed | 4 flaky (passed on retry) | 0 skipped.
- **Improvement vs previous run:** More passes (73 vs 65), fewer flaky (4 vs 12). Same 6 tests still fail (5 AI features + 1 internationalization).

**Failed (same as before):**

1. **AI Features (5):** AI search with embeddings, AI chat interface, AI chat product questions, search results AI-enhanced descriptions, AI search various query types — semantic search no results / chat button not found / no product cards.
2. **Internationalization (1):** checkout currency follows shipping address, not language — `expect(locator).toBeVisible()` failed (cart price element not visible within timeout).

**Flaky (4):** out-of-stock products (browsing-shopping), full checkout with order confirmation, cart persists during checkout, search for red bikes.

---

## Run summary (post-plan, previous run)

| Metric   | Before plan | After plan |
|----------|-------------|------------|
| **Failed** | 1 (sale-discounts timeout) | 6 (all AI features + internationalization) |
| **Flaky** | 8 | 12 |
| **Passed** | 68 | 65 |
| **Skipped** | 6 | **0** |

- **Env fix:** Script reported `✓ Test env URLs set (workers will use these if env is forwarded)`. No "No products available in the database" or EAI_AGAIN errors appeared in the log, so URL export and/or productHelper retries are helping.
- **Skips:** Previously 6 tests were skipped (1 permanent i18n + 5 conditional AI). Now **0 skipped**: the internationalization test runs (and fails with a clear symptom), and the five AI tests run but **fail with clear errors** instead of silently skipping, as intended.
- **Sale-discounts:** The test "multiple sale items maintain discounts in cart across language changes" **passed** (✓ 77, ~1.0m). The `test.setTimeout(120000)` fix resolved the timeout.

---

## Remaining failures (6)

### 1. Internationalization — "checkout currency follows shipping address, not language"

- **Symptom:** Test timeout (45s) while waiting for `locator('[data-testid*="product-price"]').first().textContent()` on the cart page.
- **Cause:** Cart page may render slowly on Azure workers, or the selector does not match before 45s; the test had no explicit timeout or wait for visibility.
- **Fix applied:** In `internationalization.spec.ts`: added `test.setTimeout(90000)` and, before reading cart price, wait for cart to load and for the price element with `expect(cartPriceLocator).toBeVisible({ timeout: 15000 })` then `textContent()`. Re-run to confirm.

### 2–6. AI Features (5 tests)

All five AI tests failed on all 3 attempts with **explicit errors** (no silent skip):

| Test | Error |
|------|--------|
| AI search with embeddings returns relevant results | Search for "bike for mountain trails" returned no results after 20s. Check base URL, Functions URL, and semantic search/embeddings. |
| AI chat interface is accessible and responds | AI chat button not found on page. Check WEB_BASE_URL and that the app has loaded. |
| AI chat can answer product-related questions | AI chat button not found on home page. Check WEB_BASE_URL and that the app has loaded. |
| search results include AI-enhanced product descriptions | No product cards found on home page. Check WEB_BASE_URL and REST_API_BASE_URL. |
| AI search handles various query types | Search returned no results after 20s. Check Functions URL and semantic search. |

- **Likely causes:**
  - **Semantic search / embeddings:** New environment may not have embeddings indexed yet, or the Functions semantic-search endpoint is not reachable from cloud workers (e.g. env not forwarded to workers).
  - **Chat button / product cards:** Timing (home page not fully loaded before assertion) or selectors not matching the deployed UI; or workers still using wrong base URL if env is not forwarded.
- **Recommendations:**
  - If AI (semantic search, chat) is **optional** for this pipeline: keep the current behavior (fail with clear message) so that when AI is enabled, failures are visible; or reintroduce `test.skip()` when `functionsBaseUrl` is unset so new/minimal envs do not fail the suite.
  - If AI is **required**: ensure embeddings are seeded and that `WEB_BASE_URL` / `FUNCTIONS_BASE_URL` are forwarded to Azure Playwright workers (or set in the run configuration), and consider longer waits or more resilient selectors for chat button and product cards.

---

## Flaky tests (12)

These failed on the first run but passed on retry (unchanged from plan’s expectations for cross-region/latency):

- address (1), ai-chat (1), browsing-shopping (4), checkout (3), internationalization (1), password (1), search (1).

Continued flakiness is consistent with workers in West Europe hitting app/API in East US 2 (latency, DNS). The productHelper retries and env export likely reduced but did not remove it.

---

## Plan checklist

| Plan item | Status |
|-----------|--------|
| Export URL env vars in run script | Done; script confirms env set. |
| test.setTimeout(120000) for sale-discounts test at line 537 | Done; test **passed**. |
| Retries in productHelper fetchAllProducts | Done; no EAI_AGAIN / "No products available" in log. |
| Re-enable internationalization test | Done; test runs, was failing on cart price timeout — fix applied (timeout + wait for visibility). |
| ai-features: fail with clear message instead of skip | Done; 0 skipped, 5 AI tests fail with explicit errors. |

---

## Next steps

1. Re-run the suite after the internationalization change to confirm that test passes or fails with a different, actionable error.
2. Decide policy for AI tests: skip when Functions URL unset (optional AI) or require AI and fix env/embeddings/selectors.
3. Optionally increase timeouts or add retries for the flakiest specs (e.g. checkout, browsing-shopping) if the goal is to minimize flaky failures on Azure workers.
