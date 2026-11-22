---
title: Chat and MCP authentication testing
summary: Focused deployed checks and opt-in billable canaries that verify delegated customer and admin chat authorization through api-mcp.
audience: [developer, security-reviewer, ai-agent]
components: [api-functions, api-mcp, foundry]
related:
  - docs/testing/AI_AND_MCP_TESTING_GUIDE.md
  - docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md
  - docs/testing/testing-strategy.md
  - docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md
---

# Chat and MCP authentication testing

The customer-chat endpoint requires an MCP-audience OAuth token. It resolves the
caller from the signed subject, forwards that token only to the configured MCP
server, and binds stored conversation responses to the caller. A customer ID in
the request is not an authorization credential.

## Focused deployed checks

From the repository root, with the selected `azd` environment, Azure CLI
authentication, and the [assurance dependencies](../../tests/auth/container/requirements.txt):

```bash
bash tests/scripts/test-ai-chat-and-mcp.sh
```

The wrapper runs the `--chat` assurance profile. It uses two existing retained
consumer fixtures; if either is unavailable, the profile blocks without creating
an account. It checks SQL-backed product availability, missing-scope denial,
denial of detailed inventory, and customer tool ownership boundaries. Its
out-of-stock control uses a finished product with independently verified DAB
inventory rows before and after the MCP calls and follows their continuation links.
Missing customer profiles
leave owner-specific assertions blocked. It creates no orders or email and does
not invoke an AI model.

After deploying the matching MCP, agent-definition and Functions changes through
normal `azd deploy` hooks, a single, potentially billable customer-chat inference
can be explicitly enabled:

```bash
bash tests/scripts/test-ai-chat-and-mcp.sh --customer-agent-canary
```

The canary uses a product verified in the same run and a consumer token limited
to `mcp.access products.read`. Before inference it checks the selected agent's
exact read-only tool list and MCP target. Functions independently validates the
definition it actually cached and refuses fallback tools. The canary stores a
normal Foundry response and checks that the availability tool was reported; a
run-specific trace must also join its completed MCP result to the same delegated
consumer's allowed `products.read` decision and the loaded agent version.
Missing or sampled telemetry, or a model that does not select the tool, remains
BLOCKED. No response text, product data, user subject or token is exported.

For the admin analytics agent, after deploying its Functions tool guard, opt into
one separate potentially billable inference:

```bash
bash tests/scripts/test-ai-chat-and-mcp.sh --admin-agent-canary
```

The selected admin definition must match the reviewed 15 read-only tools and MCP
target. The test first verifies an admin `get_business_stats` read and a
manufacturing user's `sales.read` denial. Its single admin-chat request asks for
the dashboard, sales by status and top-selling products. For each of those three
tools, a run-specific trace must correlate the completed MCP result and loaded
agent version with the same delegated employee's allowed `sales.read` decision.
Unselected tools or missing telemetry remain BLOCKED; a narrative response is not
execution evidence. Business data, tokens, user subjects and model text are
withheld from the report. The normal Foundry response is stored; no order,
simulator or email mutation is attempted.

Add `--agent-tool-sweep` to either canary to prompt each reviewed chat tool that
the run has not yet correlated, one potentially billable request per tool. Each
trace must also match the SQL session principal that the MCP or Functions
workload reported, as described in the
[agent tool sweep](../features/authentication/END_TO_END_AUTHENTICATION.md#agent-tool-sweep-and-generation-agent-canaries).

Each opt-in chat canary also checks sampled completed-response telemetry for
the Functions-to-Foundry bearer token's client-ID match. It binds a hash of the
configured ID to the selected attached identity and verifies the Functions host,
Foundry project and agent settings. Tokens and raw client IDs are not exported.
Missing or unverifiable telemetry is BLOCKED; a detected mismatch fails. This
in-process evidence covers observed response rounds only and does not replace
the separate delegated MCP authorization correlation.

Reports are written under ignored `.auth-results/` directories. Exit status is
`0` for all applicable checks passing, `1` for failures and `2` for blocked
evidence. These focused checks do not prove all agent, tool, ownership or Azure
dependency paths. See the [end-to-end guide](../features/authentication/END_TO_END_AUTHENTICATION.md)
for the full assurance scope and exceptions.

## Customer-facing tools

| MCP tool | Purpose |
| --- | --- |
| `get_customer_orders` | Signed-in customer's order history |
| `get_order_details` | Signed-in customer's order details |
| `find_complementary_products` | Related products |
| `search_products` | Finished-goods search |
| `get_product_details` | Product specifications |
| `get_personalized_recommendations` | Customer-owned recommendations |
| `analyze_product_reviews` | Review summaries |
| `get_product_availability` | Product ID and in-stock boolean, or null if not found |

`check_inventory_availability` is internal-only. The separate
`get_categories_with_products` tool remains available with `products.read` and
returns aggregate numeric stock quantities; public DAB `ProductInventory` also
exposes per-location quantities. The customer-safe availability tool does not
remove those documented demo exposures.

## Request path

```
Signed-in customer -> Functions /api/agent/chat -> configured Foundry agent
                    -> delegated MCP token -> authorized /mcp tool -> SQL
```

The chat response's `threadId` is a Foundry response ID for the same caller and
agent. It is not a shared thread identifier. Never enable shell tracing or print
tokens, passwords, private responses or the complete `azd` environment while
testing. For manual authenticated calls, use the
[authentication helper](AZURE_AUTHENTICATED_SCRIPTS.md); use the
[MCP scope matrix](../features/mcp-oauth/TOOL_SCOPE_MATRIX.md) for all tool policies.

## Related

- [AI and MCP testing guide](AI_AND_MCP_TESTING_GUIDE.md)
- [Testing strategy](testing-strategy.md)
- [Authenticated scripts](AZURE_AUTHENTICATED_SCRIPTS.md)
