using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.Extensibility;

namespace AdventureWorks.Services;

/// <summary>
/// Stamps a stable cloud role name so api-mcp appears as a distinct node in the
/// Application Insights Application Map alongside the other AdventureWorks services.
/// </summary>
public sealed class CloudRoleNameTelemetryInitializer : ITelemetryInitializer
{
	public const string RoleName = "api-mcp";

	public void Initialize(ITelemetry telemetry)
	{
		telemetry.Context.Cloud.RoleName = RoleName;
	}
}
