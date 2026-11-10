using System.Text.Json;
using System.Text.Json.Serialization;
using AdventureWorks.Auth;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;
using Xunit;

namespace AdventureWorks.Tests;

public class AuthInventoryTests
{
    [Fact]
    public void Discovered_sdk_tools_exactly_match_authorization_registry()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddMcpServer().WithToolsFromAssembly(typeof(ToolAuthorizationRegistry).Assembly);
        using var provider = services.BuildServiceProvider();
        var tools = provider.GetServices<McpServerTool>()
            .Select(tool => tool.ProtocolTool.Name).Order().ToArray();
        Assert.NotEmpty(tools);
        Assert.Equal(tools.Length, tools.Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(ToolAuthorizationRegistry.ToolNames.Order(), tools);
        var inventory = tools.Select(name => new
        {
            Name = name,
            Policy = ToolAuthorizationRegistry.Find(name),
        }).ToArray();
        Assert.All(inventory, tool => Assert.NotNull(tool.Policy));
        var output = Environment.GetEnvironmentVariable("AUTH_MCP_INVENTORY");
        if (!string.IsNullOrEmpty(output))
        {
            var options = new JsonSerializerOptions { WriteIndented = true };
            options.Converters.Add(new JsonStringEnumConverter());
            File.WriteAllText(output, JsonSerializer.Serialize(inventory, options));
        }
    }
}
