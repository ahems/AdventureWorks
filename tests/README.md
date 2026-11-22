---
title: Tests (tests/) — index of repository test folders and component test suites
summary: Short index of the repository-level test folders (test scripts, the authentication assurance suite and shared TypeScript helpers) and where each component's own test suite lives.
audience: [developer, operator, ai-agent]
components: [tests, api-functions, api-mcp, app, app-manufacturing, mcp-inspector, seed-job]
related: [docs/testing/testing-strategy.md, tests/scripts/README.md, docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md]
---

# Tests (`tests/`)

This is an index. The **[testing strategy](../docs/testing/testing-strategy.md)**
explains what each suite proves, how to run it and its side effects. The
**[test scripts catalog](scripts/README.md)** has per-script usage.

## Repository test folders

| Folder | Contents |
| --- | --- |
| [`scripts/`](scripts/README.md) | Offline Node and Python regression tests, the authentication assurance runner `validate-auth.sh`, runtime identity probes, browser runners and deployed-API scripts |
| [`auth/`](auth/) | Authentication assurance engine (`validate.py`), contracts, the agent tool sweep, order canary, mutation suite and their unit tests |
| [`utils/`](utils/) | Shared TypeScript helpers for the `check-*-dab.ts` scripts |

## Component test suites

| Suite | Location |
| --- | --- |
| Functions (xUnit) | [`api-functions.Tests/`](../api-functions.Tests/) |
| MCP and OAuth server (xUnit) | [`api-mcp/AdventureWorks.Tests/`](../api-mcp/AdventureWorks.Tests/) |
| Manufacturing app (Vitest) | `app-manufacturing/src/**/*.test.ts(x)` |
| Storefront scripts (`node --test`) | `app/scripts/*.test.mjs` |
| MCP Inspector gateway (`node --test`) | [`mcp-inspector/gateway.test.mjs`](../mcp-inspector/gateway.test.mjs) |
| Seed job (Python and PowerShell) | [`seed-job/tests/`](../seed-job/tests/) |
| Docs link checker (`node --test`) | [`scripts/utilities/check-docs-links.test.mjs`](../scripts/utilities/check-docs-links.test.mjs) |

## Quick offline checks

Run from the repository root; neither command calls Azure.

```bash
bash tests/scripts/validate-auth.sh --offline
node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs
```

Deployed checks need an existing azd environment and tokens from
[`azure-auth.py`](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md). Prefer read-only
checks, and clean up any test data you create.
