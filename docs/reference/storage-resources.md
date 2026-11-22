---
title: Azure Storage resources reference (queues, tables, blob containers, file share)
summary: Every queue, table, blob container and file share in the AdventureWorks storage account, with its purpose, producers and consumers, owning service, Web PubSub group and startup health-check coverage, plus the rules for adding storage resources.
audience: [developer, operator, ai-agent]
components: [api-functions, api-mcp, seed-job, infra]
related:
  - docs/architecture/data-stores.md
  - docs/reference/webpubsub-events.md
  - docs/reference/functions-routes.md
  - docs/reference/azure-resources.md
---

# Azure Storage resources reference: queues, tables, blob containers and file share

AdventureWorks uses one Azure Storage account for application queues, application state tables, the Durable Functions task hub, receipt and translation blobs, the Functions deployment package and the seed-job log share. Every resource listed here is created by infrastructure-as-code; application code never creates storage resources at runtime.

**How this page was derived.** From the source tree:

- Resource names and properties: [`infra/modules/storage.bicep`](../../infra/modules/storage.bicep) (`applicationQueueDescriptions`, `blobServices.containers`, `tableServices.tables`, `fileServices.shares`).
- Health-check lists: `ApplicationQueues`, `ApplicationTables` and `ApplicationContainers` in `api-functions/Services/DependencyHealthService.cs`.
- Producers and consumers: queue-name constants, `[QueueTrigger]` attributes and table-client usage in `api-functions/Functions/` and `api-functions/Services/`, and `AzureTableMcpTaskStore` in `api-mcp/`.

## Storage account

| Setting | Value |
|---|---|
| Kind and SKU | StorageV2, `Standard_LRS`, Cool access tier (Azure Verified Module `avm/res/storage/storage-account`) |
| Shared key access | Disabled; all access uses Microsoft Entra ID (managed identity) |
| Public network access | Disabled; private endpoints for blob, queue, table and file |
| Runtime managed identity roles | Storage Blob Data Owner, Storage Queue Data Contributor, Storage Table Data Contributor, Storage File Data Privileged Reader |
| Deployer roles (for local development) | Storage Blob Data Contributor, Storage Queue Data Contributor, Storage Table Data Contributor, Storage File Data SMB Share Contributor |

Functions connects with identity-based settings (`AzureWebJobsStorage__accountName`, `__blobServiceUri`, `__queueServiceUri`, `__tableServiceUri`, `__credential`, `__clientId`). See [environment variables](environment-variables.md).

## Application queues (15, each with a poison queue)

Each queue also has a `<name>-poison` queue. Queue triggers use the `host.json` settings: batch size 16, 5 dequeue attempts before a message moves to the poison queue, 30-minute visibility timeout.

| Queue | Purpose | Producers | Consumer function |
|---|---|---|---|
| `order-receipt-generation` | Generate PDF receipts for orders | `OrderPlacedSqlTrigger`, `GenerateOrderReceipts_HttpStart`, `GenerateMissingReceipts` | `GenerateOrderReceipts_QueueTrigger` |
| `order-email-generation` | Send order confirmation emails with the receipt attached | Receipt generation | `SendOrderEmail_QueueTrigger` |
| `ai-job-image-queue` | Serial queue for AI image generation | `GenerateProductImages` | `AIJobProcessor_Image_QueueTrigger` |
| `ai-job-chat-queue` | Serial queue for chat-model jobs: translations, review and order generation | `GenerateProductReviewsUsingAI`, `TranslateProductDescriptions`, `GenerateOrdersBulk`, `GenerateReviewsWithReplies` | `AIJobProcessor_Chat_QueueTrigger` |
| `ai-job-embeddings-queue` | Serial queue for product and review embeddings | `GenerateProductEmbeddings`, `GenerateProductReviewEmbeddings` | `AIJobProcessor_Embeddings_QueueTrigger` |
| `product-thumbnail-generation` | Generate thumbnails from large product images | `GenerateProductImages` | `GenerateProductThumbnails_QueueTrigger` |
| `sales-order-status` | Advance sales order status | `OrderPlacedSqlTrigger`, order pipeline and order status routes, `WarehouseService`, the consumer itself (re-queue) | `ProcessSalesOrderStatus_QueueTrigger` |
| `production-wo-queue` | Drive the manufacturing simulation, one message per work-order routing phase | Manufacturing control and simulator routes, the consumer itself (re-queue) | `WorkOrderOperationProcessor` |
| `supply-chain-orders-queue` | Drive purchase order state transitions and vendor restocks | `SupplyChainService`, supply-chain routes, the consumer itself | `PurchaseOrderProcessor` |
| `simulation-order-queue` | Shopping simulator: one message per simulated customer order | `ShoppingSimulator_Timer` (through `ShoppingSimulatorService`), the consumer itself | `SimulationOrder_QueueTrigger` |
| `warehouse-ops-queue` | Drive the warehouse simulation (store, retrieve, receive phases) | `WarehouseService` | `WarehouseOperationProcessor` |
| `review-moderation-queue` | Background AI review moderation | `ReviewModeration_StartAnalyzeApproveAll` | `ReviewModeration_QueueTrigger` |
| `manufacturing-agent-queue` | Manufacturing AI agent runs triggered by new sales orders | `OrderPlacedSqlTrigger`, `ManufacturingAgentRunService`, the consumer itself (retry) | `ManufacturingAgentQueue_QueueTrigger` |
| `auto-promotion-queue` | Automatic AI promotions triggered by order-volume thresholds | `OrderPlacedSqlTrigger` | `AutoPromotion_QueueTrigger` |
| `utility-status-queue` | Observe Durable utility jobs until they finish | `RegisterUtilityLifecycle`, the consumer itself (3-second re-queue) | `ObserveUtilityLifecycle` |

## Tables

| Table | Owner | Contents | Web PubSub group (`state-changed`) |
|---|---|---|---|
| `shoppingSimulator` | `ShoppingSimulatorService` | Shopping simulator configuration, state and results | `shopping-simulator` |
| `awOrderPipelineConfig` | `OrderPipelineConfigService` | Order pipeline delays and delivery windows | `orders` (sanitized) |
| `awSupplyChain` | `SupplyChainService` | Supply-chain simulation state and purchase-order tracking | `supply-chain` |
| `awManufacturing` | `WorkOrderSimulationService`, `WorkforceService` | Manufacturing simulation state, scrap and location configuration, workforce | `manufacturing-ops` |
| `awBankAccounts` | `BankService` | Bank simulator accounts | `finance` (sanitized) |
| `awBankTransactions` | `BankService` | Bank simulator transactions | `finance` (sanitized) |
| `awWarehouse` | `WarehouseService` | Warehouse simulation state and subcategory configuration | `warehouse` |
| `awManufacturingAgentConfig` | `ManufacturingAgentConfigService` | Manufacturing agent mode | `manufacturing-agent` |
| `awManufacturingAgentRuns` | `ManufacturingAgentRunService` | Manufacturing agent run history and steps | `manufacturing-agent` |
| `awManufacturingProposals` | `ManufacturingProposalService` | Agent proposals awaiting human approval | `manufacturing-agent` |
| `verifiedReviewsJob` | `ReviewService` | Verified-review generation job state | — (explicit `reviews` events) |
| `reviewModerationJob` | `ReviewService` | Review moderation job state | — (explicit `reviews` events) |
| `awAutoPromotionConfig` | `AutoPromotionConfigService`; counter updated by `OrderPlacedSqlTrigger` | Auto-promotion settings and order counter | `promotions` |
| `awMcpTasks` | api-mcp `AzureTableMcpTaskStore` | MCP Tasks state for long-running tool calls | — |

The first 13 tables are the Functions application tables checked at startup. `awMcpTasks` belongs to api-mcp and is checked by its `/ready` endpoint instead.

## Blob containers

| Container | Purpose |
|---|---|
| `adventureworks-receipts` | Generated PDF order receipts; also read as email attachments |
| `locales` | Translated UI language files written by `TranslateLanguageFile` and the translation scripts |
| `function-releases` | Flex Consumption deployment packages published by `azd deploy` |
| `azure-webjobs-hosts`, `azure-webjobs-secrets` | Azure Functions host |

## File share

| Share | Settings | Purpose |
|---|---|---|
| `seed-job-logs` | SMB, 5 GB, TransactionOptimized, identity-based access | The seed job writes `seed-*.log` through the Container Apps environment storage `seed-job`. `GET /api/seed/status` and the Functions readiness `files` probe read it. |

## Durable Functions task hub

Hub name `AdventureWorksFunctions` (from `api-functions/host.json`), Azure Storage provider, 4 partitions. All task-hub resources are pre-provisioned:

| Type | Names |
|---|---|
| Queues | `adventureworksfunctions-control-00` to `-03`, `adventureworksfunctions-workitems` |
| Tables | `AdventureWorksFunctionsHistory`, `AdventureWorksFunctionsInstances`, `AdventureWorksFunctionsPartitions`, plus `AzureFunctionsDiagnosticEvents` for the host |
| Blob containers | `adventureworksfunctions-leases`, `adventureworksfunctions-applease`, `adventureworksfunctions-largemessages` |

## Startup and readiness checks

At startup, `api-functions/Program.cs` checks the `DependencyHealthService` lists without creating anything:

- Queues (and their poison queues) and containers: `GetPropertiesAsync()`.
- Tables: a one-row `QueryAsync` that selects only `PartitionKey`.

A missing resource logs a warning in Application Insights; startup does not fail. `GET /api/health/readiness` runs the same probes on demand. See [health diagnostics](../features/monitoring/HEALTH_DIAGNOSTICS.md).

## Adding a storage resource

1. **Queue:** add it to `applicationQueueDescriptions` in `storage.bicep` (the poison queue is derived) and to `DependencyHealthService.ApplicationQueues`.
2. **Table:** add it to `tableServices.tables` in `storage.bicep` and to `DependencyHealthService.ApplicationTables`.
3. **Blob container:** add it to `blobServices.containers` in `storage.bicep` and to `DependencyHealthService.ApplicationContainers`.
4. Never call `CreateIfNotExists`, `CreateIfNotExistsAsync` or `CreateTableIfNotExistsAsync` from application code.
5. New resources need infrastructure provisioning. On the demo environment, ask the environment owner to recreate it rather than creating the resource by hand.
6. Update this page.

**Test-only exception:** an automated test may create a temporary table in the existing storage account with a recognizable random test prefix, using the test's approved identity (no account keys). It must delete only that table during cleanup, including on failure. Do not add test tables to `storage.bicep` or the health-check lists.
