---
title: Application monitoring signal contract
summary: Signal ownership, bounded fields, privacy, sample-aware interpretation and capture admission for the AdventureWorks observability implementation.
audience: [developer, operator, ai-agent]
components: [api-functions, api-mcp, manufacturing-agent, app, app-admin, app-manufacturing, infra]
related:
  - docs/operations/monitoring.md
  - docs/testing/OBSERVABILITY_VALIDATION.md
---

# Application monitoring signal contract

Contract version: **1**. Configuration, export and observed ingestion are separate evidence levels. A successful build is not proof of Azure ingestion.

## Signal ownership and names

| Signal | Owner / interpretation |
| --- | --- |
| HTTP entry request | Browser page/navigation or supported server/Functions host instrumentation. Internal AI work is dependency/activity telemetry, not another HTTP request. |
| `AdventureWorks.GenAI` | Application client model/agent activities and metrics; `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, provider response ID and supplied usage. |
| `AdventureWorks.BackgroundWork` | Queue attempt/causal-link activities and metrics. `job.id`, `messaging.operation.type=process`, validated W3C parent, enqueue time and intentional visibility delay. |
| `GenAI.Capture` | Bounded sanitized content event from an admitted lease. Actual trace/parent correlation and `aw.capture.span_id`; not a synthetic request or invented full trace. |
| `browser.web-vital` | LCP/INP/CLS, value, route template and availability. Missing observations are not zero. |
| `browser.http-outcome`, `browser.handled-outcome`, `browser.realtime-outcome` | Low-volume logical outcomes, including GraphQL errors on HTTP 200 and realtime connection/publisher failures. Sending a message does not prove browser receipt. |
| `Sql.SessionPrincipal`, `McpToolAuthorization` | Existing identity/auth evidence retains its meanings. Never replace infrastructure identity evidence with an application-user identity. |
| Native resource metrics | Azure Monitor at the actual resource/subresource scope. No extra ingestion stream copying all metrics or resource logs. |

Outcomes: `success`, `rejected`/validation, `unauthorized`, `forbidden`, `application-failure`, `upstream-failure`, `throttled`, `timeout`, `cancelled`, `skipped`, `partial`, `retrying`, `poisoned`. GenAI uses `aw.outcome`; queue activities use `outcome`. A retry is not a poisoned job; only poison transfer/metadata proves that.

Metrics use low-cardinality service, operation class, model/deployment, known tool and failure/outcome dimensions. Trace, run, order, session, customer and grant IDs belong only in diagnostic traces. Do not attach prompts, JWTs, URL queries, SQL text, arbitrary exception messages or tool arguments to normal metric/log dimensions.

Keep stable service roles and stamp actual build/environment attribution through provider resources. Do not invent a production environment or fabricate missing build/version values.

## Sampling, usage and boundaries

Server-entry requests, client activities and provider/server Foundry traces have different owners. The query API reports observed spans, `ItemCount`-estimated requests/events and ingested percentiles separately. Head-sampled traces can omit failures and parents. No-data cannot prove idle or healthy; telemetry arriving after a push invalidation may remain absent until a later focus/filter/application event.

Provider token counters are recorded once per response ID, including intermediate rounds where supplied. Cached-input and reasoning-output tokens are subsets, not quantities to add again to input/output totals. Missing usage/rates remain unknown. Monitoring snapshots show **observed client span usage**, not complete account totals or invoices; never sum client/server duplicates.

HTTP/queue W3C continuity is distinct from SQL change-tracking causal reconstruction. The latter does not preserve a browser parent unless the application explicitly persisted it. Missing third-party segments must be identified, not fabricated.

## Privacy and capture

Default rich capture is **off**. Only executive-admin has `monitoring.read` and `monitoring.write` initially. Read routes are pure. Grants select one validated stable `session`/`job` identifier; a server-created ID plus trusted application provenance is required to admit a root. Caller trace headers and queue metadata alone do not authorize capture.

`MonitoringCaptureService.TryAcquireRootAsync(captureId, scopeType, scopeId, rootOperationId, ct)` atomically admits at most 100 distinct roots per grant. A repeated stable root ID is idempotent. Child emissions revalidate the admitted lease. Expiry is absolute 15 minutes; Stop/expiry prevents subsequent admission/content. Existing admitted roots can finish within expiry after the admission cap is reached.

The `awMonitoringCapture` Azure Table holds control metadata, admission hashes and byte counters only, never prompt/trace archives. ETag-guarded transactions protect root admission, Stop and the cumulative 32 KiB rich-text budget across instances. Each text field is at most 4 KiB UTF-8; keys are limited to `input`, `output`, `toolArguments`, `toolResult`, `reasoningSummary`. Binary/base64, image data, embeddings and encrypted/hidden reasoning are omitted. Credential patterns, signed URL queries, emails and payment-number patterns are redacted. Original byte size, truncation and omission accompany emitted fields; redaction is not permission to send arbitrary private records.

Backend integration must pass an admitted `CaptureLease` from trusted server state explicitly. Chat sessions use a server-minted monitoring session ID recovered only after conversation/agent ownership verification; that stable ID can select a session grant. Manufacturing job capture uses the canonical persisted RunId GUID, matching the run's order/customer and nonterminal state before grant lookup. It captures sanitized application input and hosted findings/actions output, not the hosted agent's internal tool spans or hidden reasoning. Retry attempts reuse the same root admission and cumulative byte budget. Queue capture metadata alone never grants access; other background producers without persisted provenance remain metadata-only. Normal metadata continues without a lease. Capture cannot retroactively change head sampling on the HTTP parent: `GenAI.Capture` uses the unsampled custom-event/log path for admitted content, but exporter failure/daily caps can still prevent ingestion. Full parent/model/third-party span retention is not promised.

Only officially returned reasoning summaries and reasoning-token counts are supported. No extraction of hidden reasoning, encrypted decoding, fabricated summaries or increased model effort for observability. Application capture does **not** control Foundry server-managed content/tracing globally. Already ingested content remains subject to retention after Stop.

## Compatibility and validation gates

Functions host and worker instrumentation remain distinct. api-mcp has one compatible Application Insights 3.x/OpenTelemetry exporter owner; AgentHost keeps its built-in exporter; DAB keeps vendor telemetry. Do not add a second distro/classic exporter. Package graphs and in-memory telemetry tests must verify compatible SDKs, role attribution, one HTTP entry, no duplicate dependencies and preserved auth/SQL evidence. A genuine SDK/platform incompatibility is a blocker, not an excuse to disable telemetry.

See [offline and deployed validation](../testing/OBSERVABILITY_VALIDATION.md). No Azure provisioning/deployment evidence was gathered by these source changes.
