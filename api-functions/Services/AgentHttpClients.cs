using Microsoft.Extensions.DependencyInjection;

namespace api_functions.Services;

public static class AgentHttpClients
{
    public const string HostedManufacturing = "HostedManufacturingAgent";

    public static IServiceCollection AddAgentHttpClients(this IServiceCollection services)
    {
        foreach (var name in new[] { nameof(FoundryAgentClient), nameof(McpServiceTokenProvider), HostedManufacturing })
        {
            services.AddHttpClient(name)
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        }

        return services;
    }
}
