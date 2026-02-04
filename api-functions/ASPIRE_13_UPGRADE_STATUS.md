# Aspire 13.1.0 Integration - Breaking Changes Summary

**Date:** 2026-01-22

## Changes Applied

### Successfully Updated

1. ✅ Upgraded Aspire packages from 8.2.2 to 13.1.0:
   - `Aspire.Microsoft.Data.SqlClient`
   - `Aspire.Azure.Storage.Blobs`
   - `Aspire.Azure.Storage.Queues`

2. ✅ Updated Azure Storage SDK packages to match Aspire 13.1.0 requirements:
   - `Azure.Storage.Blobs`: 12.26.0 → 12.27.0
   - `Azure.Storage.Queues`: 12.22.0 → 12.25.0

3. ✅ Fixed deprecated Aspire API calls in Program.cs:
   - `AddAzureBlobClient` → `AddAzureBlobServiceClient`
   - `AddAzureQueueClient` → `AddAzureQueueServiceClient`

4. ✅ AppHost project updated:
   - Added `Aspire.Hosting.Azure.Functions` package (13.1.0)
   - Added project reference to api-functions
   - Updated to use `AddAzureFunctionsProject<T>()` instead of `AddProject<T>()`

5. ✅ Added ServiceDefaults integration:
   - Added project reference to ServiceDefaults
   - Added `builder.AddServiceDefaults()` call after builder creation

6. ✅ Cleaned up local.settings.json per Aspire best practices:
   - Only `FUNCTIONS_WORKER_RUNTIME` remains
   - All other configuration should come from AppHost

### Blocked by Agent Framework API Changes

**Microsoft.Agents.AI preview packages** have introduced breaking changes:

- `IChatClient.CreateAIAgent()` extension method no longer exists
- `AIAgent.GetNewThread()` method no longer exists
- These APIs are used in:
  - `Program.cs` (line 210): durable agent registration
  - `Services/AIAgentService.cs` (lines 156, 300): thread management

### ApplicationInsights Package Status

**Kept** `Microsoft.ApplicationInsights.WorkerService` version 2.23.0 because:

- Multiple service classes depend on `TelemetryClient` (AIAgentService, AIService)
- Function classes use ApplicationInsights APIs directly
- Aspire docs note version 2.23.0 fixes runtime errors that occurred with 2.22.0
- While Aspire recommends using OpenTelemetry via ServiceDefaults, the existing telemetry code needs refactoring first

## Recommendations

### Immediate Next Steps

1. Update Agent Framework usage to match current preview API:
   - Consult Microsoft.Agents.AI documentation for new agent registration pattern
   - Update thread management calls in AIAgentService
   - May require switching to a different agent construction approach

2. Consider telemetry refactoring (lower priority):
   - Migrate from direct TelemetryClient usage to Activity-based OpenTelemetry tracing
   - This would allow removing ApplicationInsights package per Aspire guidance
   - ServiceDefaults already provides OpenTelemetry with Azure Monitor export

### Testing Checklist

Once Agent Framework APIs are fixed:

- [ ] `dotnet restore && dotnet build` succeeds
- [ ] `func start` runs locally
- [ ] AppHost orchestration works (`dotnet run` in AppHost project)
- [ ] Storage connections work via Aspire integration
- [ ] SQL connections work via Aspire integration
- [ ] AI agent functions initialize properly
