---
title: End-to-end observability validation
summary: Evidence required to demonstrate application, agent, workflow and resource-limit telemetry without treating configuration or missing data as a successful measurement.
audience: [developer, operator, demo-presenter]
components: [app, app-admin, app-manufacturing, api, api-functions, api-mcp, manufacturing-agent, mcp-inspector, seed-job, infra]
related:
  - docs/operations/monitoring.md
  - docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md
  - docs/testing/testing-strategy.md
---

# End-to-end observability validation

Application Insights configuration is not proof of ingestion or correlation.
Use the [monitoring guide](../operations/monitoring.md) for the instrumentation
and dashboard contracts. This page defines the evidence needed for a demo.

## Offline evidence

Run the tests covering the files changed, then the integrated gates:

```bash
python3 -B -m unittest discover -s tests/scripts -p 'test_azure_auth.py'
python3 -B -m unittest discover -s tests/scripts -p 'test_observability_verifier.py'
node --test tests/scripts/test-frontend-telemetry-envelopes.mjs
node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs
cd app && node --test scripts/telemetry-privacy.test.mjs
```

The shared authenticated helper requests monitoring scopes only for the executive
admin identity. Scope requests do not grant access by themselves: the OAuth
server and Functions route policies must independently authorize the caller.

For server telemetry, use in-memory exporters and fixture responses. Assert
actual exported spans, events and metrics, not source-code strings alone:

- One incoming server request, correctly attributed role/version and parent ID,
  with no duplicate automatic dependency spans.
- HTTP 200 GraphQL errors and MCP `isError` results are logical failures, not
  successful business operations.
- Model-round usage is counted exactly once, including approval continuations.
  Missing provider usage is unknown, not a zero-token success.
- Queue retries have individual attempts and one logical terminal outcome.
  Durable replay does not duplicate business metrics.
- Exception, query, header and nested content fixtures never export credential
  markers, even in rich-capture mode.
- Capture expires, stops, enforces its operation and payload limits, and does
  not enable unrelated concurrent sessions.
- Dashboard query errors, empty data, stale observations and partial source
  results remain distinct.

The no-polling regression remains mandatory. A display clock may update elapsed
time, but it must not make network requests.

## Deployment prerequisites

Provisioning is user-run. Agents do not create or repair Azure resources in
place. For a new demo, use the normal deployment instructions and wait for the
asynchronous seed job to succeed before validating data-dependent telemetry.
For infrastructure changes to an existing disposable environment, follow the
[deployment policy](../operations/deployment.md).

Read only the selected azd outputs needed for each check. Use
[azure-auth.py](AZURE_AUTHENTICATED_SCRIPTS.md) for application calls. Never use
an Entra management token as a seeded AdventureWorks user, print bearer tokens,
or dump the environment.

The following proof layers are separate:

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Connection string / endpoint configured | Instrumentation has a destination | Export or ingestion |
| Browser batch accepted | Ingestion endpoint accepted browser envelopes | Server request or SQL correlation |
| Exported local fixture spans | Instrumentation emits the expected shape | Azure accepted/stored it |
| Queried known trace | Azure stored the observed operation | Every service/path is instrumented |
| Native resource metric | That metric was available for its resource/time range | Every quota has a corresponding live counter |
| Dashboard data | Authorized snapshot queries succeeded | Zero failures when a source is absent |

## Browser ingestion

Use the existing anonymous browser runner before generating business traffic:

```bash
APP_URL=$(azd env get-value APP_URL --no-prompt) \
APP_ADMIN_URL=$(azd env get-value APP_ADMIN_URL --no-prompt) \
APP_MANUFACTURING_URL=$(azd env get-value APP_MANUFACTURING_URL --no-prompt) \
node tests/scripts/test-frontend-telemetry.mjs --output .auth-results/frontend-telemetry.json
```

This runner blocks cross-origin API calls and does not sign users in. It is an
ingestion/role check, not an end-to-end distributed trace check. Inspect each
site's result; an error or absent envelope is not a pass. The runner exits
nonzero if any site is missing, misattributed or only partially accepted.

## Presenter walkthrough

1. Sign into the admin app as the executive admin and open monitoring.
2. Select a time range. Verify source timestamps, coverage and ingestion-delay
   notes before interpreting counts.
3. Make an ordinary catalog request from the storefront and inspect the browser,
   DAB request and SQL dependency segments in Application Insights.
4. Run one selected agent scenario only after approving its model-call cost.
   Compare the agent invocation with individual model rounds, tool execution,
   token usage, validation and retry outcomes.
5. Enable bounded rich capture for a supported demo session/job. Inspect the
   available sanitized application inputs and outputs. Reasoning summaries are provider-exposed
   summaries, not raw hidden model reasoning; absent/unsupported summaries are
   normal and must be labeled.
6. Stop capture. Confirm further operations return to metadata-only collection.
   Stopping capture does not delete telemetry already ingested.
7. For a controlled test order/job, follow enqueue, attempt, retry and terminal
   state. SQL change tracking may start a new trace; use causal business IDs to
   explain this boundary rather than claiming an unbroken trace.
8. Show resource pressure and ingestion/cap usage. A free-tier limit is a known
   constraint, not proof that its remaining quota can be read in real time.
9. Open the workbook or optional portal Grafana view. Portal access uses the
   presenter's own Entra permissions, not the seeded application's OAuth token.

Do not launch a long shopping simulation, send real emails, exhaust quotas,
fill storage or crash infrastructure to demonstrate monitoring.

### Capture selection and boundaries

For chat, copy the server-issued monitoring session ID exposed by the chat UI.
This is not a user ID, browser tab ID or trace ID. For job content capture, use
the canonical persisted manufacturing `RunId`. The consumer verifies the stored
run, matching order/customer and nonterminal state; a queue-supplied capture
reference cannot authorize capture.

Manufacturing capture includes bounded application input and parsed hosted-agent
findings/recommendations/actions, not internal hosted tool bodies or hidden model
reasoning. Other job types remain metadata-only. Provider-managed tracing is
independent and is not switched globally by this control.

Each grant expires after 15 minutes or 100 root operations. Text fields are
limited to 4 KiB and each root has one cumulative 32 KiB budget, including retries.
Stop and expiry prevent further content emission. Credentials and payment details
remain redacted in every mode; stop does not erase already ingested telemetry.

## Selected trace metadata verification

The [read-only metadata verifier](../../tests/scripts/test-observability.py)
queries only request/dependency identifiers, role, success and GenAI operation
metadata. It does not query prompt content, headers, SQL text or log messages:

```bash
python3 -B tests/scripts/test-observability.py \
  --trace-id <32-character-lowercase-W3C-trace-id> \
  --expected-role api-functions \
  --require-gen-ai \
  --output .auth-results/observability-metadata.json
```

The output directory must already exist. The workspace is read from the selected
azd `MONITORING_WORKSPACE_ID` output, or supplied explicitly with `--workspace-id`
(the workspace customer ID GUID, not its ARM resource ID). This read-only Azure
Monitor query uses the operator's Azure CLI identity. It is not an application
API call and does not impersonate the executive admin.

Repeat `--trace-id` up to 20 times and `--expected-role` for roles that must occur
in **each** selected trace. The lookback is one hour and at most 2,000 metadata
rows are read. A missing role, absent parent link, invalid/duplicate span ID or
possibly truncated query fails. Zero W3C IDs and self-parent links are invalid
evidence. Azure query/RBAC failure is blocked (exit 2);
unobserved/invalid evidence fails (exit 1). No rows is not successful evidence.

This is a bounded one-shot query, not a telemetry polling loop. Wait for normal
ingestion before running it. A pass proves an observed parent relationship and
the selected roles, not complete coverage of every service or content redaction.
Use emitted-payload fixture tests and selected demo-run inspection for the
remaining acceptance checks.

DAB 2.1.7 has been observed to emit a SQL dependency with a 32-character ID
while retaining the request's W3C span as its parent. The strict verifier
reports this as an invalid span ID, even when the parent link is present. Report
the failed strict check and the observed link separately; do not treat that SQL
dependency ID as a valid W3C span ID.

## Cost and performance evidence

Compare a bounded warm baseline with a modest demo workload. Record the
scenario, operation counts, duration distribution, model usage, observed runtime
pressure and ingested billable bytes. Keep cold starts and intentional queue
delays separate from processing latency.

Sampling affects trace counts and percentiles. Use sample weights where the
source supports them and use unsampled outcome metrics for totals. A retained
exception without its parent is not a complete trace. Token costs are estimates
unless the deployment's rates and all usage are known.

The workspace daily cap is an emergency safeguard. It can overshoot, and a cap
event can make the dashboard incomplete until ingestion resumes. Missing or
stale telemetry must not become a green health badge.

## Final evidence report

Record tested service roles and paths, known trace/job IDs, exporter shape and
ingestion checks, observed causal boundaries, redaction results, capture expiry,
resource metric support and measured volume. Report unavailable permissions or
preview/tier capabilities as blocked or unsupported, not successful.

Without a deployed environment, local tests can prove code behavior but Azure
ingestion, end-to-end correlation, resource-limit metrics, optional Grafana and
actual monitoring cost remain unverified.
