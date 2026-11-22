---
title: Simulator controls
summary: How to start, stop, slow down and reset the manufacturing, supply chain, bank, shopping and agent simulations, which MCP actions ask for confirmation, and how old inventory transactions are archived.
audience: [developer, demo-presenter, operator]
components: [api-functions, api-mcp, app-admin, app-manufacturing]
related:
  - docs/features/manufacturing/production-simulation.md
  - docs/features/simulators/shopping-simulator.md
  - docs/features/supply-chain/supply-chain.md
  - docs/features/finance/bank-simulator.md
---

# Simulator controls

## What it does

AdventureWorks runs several cooperating simulations. This page collects the controls that start, stop, slow down or reset them, so a demo can be returned to a known state.

| Simulation | Start | Stop or slow down |
|---|---|---|
| [Production](../manufacturing/production-simulation.md) | `POST manufacturing/begin` | `POST manufacturing/stop` |
| [Shopping](shopping-simulator.md) | `POST shopping-simulator/start` | `POST shopping-simulator/stop`; stops itself after `DurationHours` |
| [Manufacturing agent](../manufacturing/manufacturing-agent.md) | `PUT manufacturing/agent-config` with mode 1–3 | Mode 0, or the auto-shutoff time |
| [Supply chain](../supply-chain/supply-chain.md) | Initialized by the maintenance timer on host start | `PUT supply/config` (speed multiplier 1–50) |
| [Warehouse](../warehouse/warehouse-operations.md) | Always on | Idle when no work arrives |
| [Bank](../finance/bank-simulator.md) | Seeded by the maintenance timer on host start | Reset only |

## Try it

**UI:** stop controls are on the Manufacturing portal's **Production**, **Manufacturing Agent** and **Settings** pages and the Admin portal's **Shopping Simulator** page.

**API (full reset):**

```bash
python3 scripts/utilities/azure-auth.py request --identity admin \
  --resource functions --path /api/simulators/reset --method POST
```

This is destructive for simulation data: it wipes bank transactions and returns seeded purchase orders to their initial state.

## How it works

```mermaid
flowchart LR
    R["POST /api/simulators/reset"] --> M["1. Clear manufacturing<br/>work-order queue"]
    M --> S["2. Reset supply chain<br/>revert seeded POs, re-seed vendor stock"]
    S --> B["3. Reset bank<br/>wipe, re-seed USD balance"]
    B --> SH["4. Stop shopping simulator<br/>clear queue and counters"]
    SH --> RES["Per-step results"]
```

The steps run in this order so bank transactions stay consistent with the simulators. If a step fails, the response is HTTP 500 with a per-step result list; other steps may still have succeeded. The USD balance is seeded from a historical profit query.

### MCP confirmation

These MCP tools ask the user to confirm (MRTR) before acting unless the call passes `confirmed=true`:

| Tool | Scope |
|---|---|
| `begin_manufacturing_run` | `manufacturing.write` |
| `stop_manufacturing` | `manufacturing.write` |
| `update_scrap_configuration` | `manufacturing.write` |
| `update_location_configuration` | `manufacturing.write` |
| `reset_all_simulators` | `mcp.admin` (executive-admin only); 200-second timeout |

## Transaction archive

Production and warehouse activity writes many `Production.TransactionHistory` rows. `TransactionHistoryArchiveFunction` moves rows older than one year into `Production.TransactionHistoryArchive`:

- **Timer:** every Sunday at 02:00 UTC (`0 0 2 * * 0`).
- **On demand:** `POST /api/archive/trigger` (`admin.write`) runs the archive immediately and returns `recordsArchived`.

In the Admin portal, **Inventory Transactions** has a **Show Archive** toggle to browse archived rows.

## Data & storage

Reset touches the manufacturing queue, `awSupplyChain`, `Purchasing.PurchaseOrder*`, `awBankAccounts` / `awBankTransactions` and the `shoppingSimulator` table and queue. The archive touches `Production.TransactionHistory` and `Production.TransactionHistoryArchive`.

## Events

Each step publishes its own simulator's events, such as `queue-cleared`, `state-changed` and `simulator-stopped`, so open pages refresh without polling.

## Security

| Action | Scope |
|---|---|
| `POST /api/simulators/reset` | `admin.write` |
| `POST /api/archive/trigger` | `admin.write` |
| MCP `reset_all_simulators` | `mcp.admin` |

## Configuration

`SIMULATION_TIME_SCALE_FACTOR` (simulated speed) and the supply-chain speed multiplier; see [production simulation](../manufacturing/production-simulation.md).

## Limits

- Reset does not delete sales orders, work orders, purchase orders or customers created while the simulators ran. It only returns seeded purchase orders that the simulation resolved to Approved, so the next initialization replays them.
- Reset does not change the manufacturing agent mode; set it to Off separately.

## Related code & docs

- `api-functions/Functions/SimulatorControlFunction.cs`, `TransactionHistoryArchiveFunction.cs`
- `api-mcp/AdventureWorks/Tools/SimulatorMcpTools.cs`
- `app-admin/src/pages/InventoryTransactionsPage.tsx`
