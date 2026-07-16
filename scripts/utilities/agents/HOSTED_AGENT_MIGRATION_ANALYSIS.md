# Hosted vs Chat Agent Migration Analysis

**Date:** 2026-07-16
**Scope:** All Azure AI Foundry agents in `scripts/utilities/agents/`

## Current Architecture

All agents are deployed as **`kind: prompt`** (standard/chat) agents in Azure AI Foundry. They use MCP tools (adventureworks_mcp, dabmcp), memory stores, structured inputs via Handlebars templates, and workflow orchestration.

### Agent Inventory by Usage Pattern

| Pattern | Agents | How Invoked |
|---------|--------|-------------|
| **Programmatic (fire-and-forget)** | admin-order, admin-cart-recovery, admin-customer, admin-review, manufacturing | Azure Functions / simulator creates thread → posts message → collects JSON response |
| **Interactive chat** | admin-chat, eshop-chat | UI-driven multi-turn via thread API |
| **Wizard / sync UI** | eshop-help-me-choose, admin-product-content, admin-promotion | Called from admin UI wizards that need the JSON response immediately |
| **Workflow orchestration** | eshop-workflow, admin-order-workflow, admin-promotion-workflow | Declarative YAML routing between sub-agents |
| **Intent classifiers** | eshop-intent, admin-order-intent, admin-promotion-intent | Micro-agents (no tools) used by workflow agents |

## What "Hosted" Agents Provide

Azure AI Foundry **hosted agents** run as always-on managed compute with their own endpoints. They can be triggered by events (HTTP webhooks, queue messages, schedules) without a client application managing the thread/run lifecycle.

Key differences from chat agents:

- **Autonomous execution** — no client needed to drive conversation turns
- **Event-driven triggers** — queue messages, webhooks, timers
- **Server-side state management** — Foundry manages threads and runs internally
- **No streaming to client** — results are stored/forwarded, not streamed

## Migration Assessment Per Agent

### Strong Candidate: manufacturing-agent

The `manufacturing-agent` is the strongest candidate for migration. It is already autonomous — triggered by the `OrderPlacedSqlTrigger` Azure Function when a new order is detected. Currently the Function must:

1. Obtain a Foundry token
2. Create a thread
3. Post the order context as a message
4. Create a run and poll for completion
5. Parse the response

With a hosted agent, this reduces to firing an event (queue message or webhook) and the agent handles everything server-side. The Azure Function orchestration code is eliminated entirely.

### Possible Candidates: Simulator Agents

The **admin-order-agent**, **admin-customer-agent**, and **admin-cart-recovery-agent** are called in loops by the shopping simulator Azure Functions. Hosted agents with queue triggers could consume `simulation-order-queue` messages directly without Functions managing the thread lifecycle.

However, the simulator currently needs the JSON response from these agents to create orders, customers, and recovery strategies in the database. Moving to hosted agents would require a callback/result-queue pattern, adding architectural complexity.

### Not Recommended: Interactive Chat Agents

**admin-chat-agent** and **eshop-chat-agent** must remain client-driven. The UI needs to:

- Stream responses token-by-token
- Display tool-call status indicators
- Manage multi-turn conversation state
- Show typing indicators and partial results

Hosted agents are designed for autonomous execution, not interactive UX. **No benefit here.**

### Not Recommended: Wizard / Sync UI Agents

**eshop-help-me-choose-agent**, **admin-product-content-agent**, and **admin-promotion-agent** are called synchronously from admin UI wizards that need the JSON response immediately to populate form fields. Hosted agents would add latency (queue → process → poll for result) with no UX benefit.

### Not Applicable: Workflow & Intent Agents

Workflow agents already use Foundry's native `kind: workflow` orchestration. Intent classifiers are minimal prompt-only agents with no tools. There is no hosted equivalent that would simplify either category.

## Effort Estimate

| Task | Effort |
|------|--------|
| Change agent `kind` from `prompt` to `hosted` in deploy scripts | Low |
| Set up event triggers (queue/webhook bindings) per agent | Medium |
| Rearchitect Azure Functions to emit events instead of managing threads | Medium–High |
| Handle async results (polling/callbacks) where UI currently awaits sync response | High |
| Testing & validation of all agent flows end-to-end | High |
| **Total (all agents)** | **~2–4 weeks** |
| **Total (manufacturing-agent only)** | **~2–3 days** |

## Recommendation

**Don't migrate the majority of agents.** The current `kind: prompt` architecture is well-suited to the use cases. The Foundry service already handles MCP tool orchestration server-side — you're already getting the main benefit of managed execution without the constraints of hosted agents.

**Do consider migrating `manufacturing-agent` only.** It's a clean isolated case:

- Already triggered by an event (SQL trigger → Azure Function)
- Runs autonomously with no user interaction
- Logs results rather than streaming to a UI
- Eliminates the Azure Function thread-management boilerplate

This validates the hosted pattern with minimal risk (~2–3 days effort) without disrupting the 9+ working chat agents.

### Summary Table

| Agent | Migrate? | Reason |
|-------|----------|--------|
| manufacturing-agent | **Yes** | Autonomous, event-driven, no UI |
| admin-order-agent | Maybe | Simulator loop — adds callback complexity |
| admin-customer-agent | Maybe | Simulator loop — adds callback complexity |
| admin-cart-recovery-agent | Maybe | Simulator loop — adds callback complexity |
| admin-chat-agent | No | Interactive streaming UI |
| eshop-chat-agent | No | Interactive streaming UI |
| eshop-help-me-choose-agent | No | Sync wizard UI needs immediate response |
| admin-product-content-agent | No | Sync wizard UI needs immediate response |
| admin-promotion-agent | No | Sync wizard UI needs immediate response |
| admin-review-agent | No | Simple, fast, no orchestration benefit |
| Workflow agents (×3) | No | Already use native `kind: workflow` |
| Intent classifiers (×3) | No | Minimal micro-agents, no benefit |
