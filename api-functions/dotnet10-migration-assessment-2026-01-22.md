# .NET 10 Migration Assessment (2026-01-22)

## Current State

- Project targets .NET 8 isolated Functions V4 (see api-functions.csproj) and the Dockerfile pins both the build (`dotnet/sdk:8.0`) and runtime (`azure-functions/dotnet-isolated8.0`) images.
- Worker dependencies (`Microsoft.Azure.Functions.Worker`, Durable Task, Storage extensions, Aspire integrations) are all built for .NET 8 today.
- Startup (Program.cs) uses the new `FunctionsApplication` builder plus Aspire SQL/Storage registrations, OpenTelemetry, and Microsoft Agent Framework with MCP integrations.
- azd/deployment workflows assume the 4-dotnet-isolated8.0 runtime image and associated tooling.

## Migration Blockers

- Azure Functions runtime has not announced .NET 10 support; no 4-dotnet-isolated10.0 base image exists, so production deployments would fail.
- Worker SDK packages must release .NET 10-compatible versions before updating `<TargetFramework>`; restoring against the current SDK will fail the TF validation.
- Aspire components, QuestPDF, Azure SDKs, Microsoft Agent Framework previews, and ModelContextProtocol packages all need confirmed .NET 10 builds.
- Container build pipeline and azd scripts are hardcoded to the .NET 8 toolchain, so even successful builds could not run locally or in Azure until images/agents are updated.

## Recommended Next Steps

1. Monitor Azure Functions announcements and wait for public previews (or GA) of .NET 10 isolated support before attempting migration.
2. Once previews exist, create a feature branch that bumps `TargetFramework`, Worker SDK, and Docker images to the .NET 10 equivalents; wire CI to run only on that branch.
3. Track upstream dependencies (Aspire, Agent Framework, QuestPDF, Azure SDK, Durable Task) for .NET 10 readiness; file issues where timelines are unclear.
4. After each preview bump, run full unit/integration tests plus `func host start` smoke tests to verify Durable Functions, queue triggers, and AI agent flows still work.
5. Keep production on .NET 8 LTS until Azure Functions .NET 10 support reaches GA and all dependencies are validated.
