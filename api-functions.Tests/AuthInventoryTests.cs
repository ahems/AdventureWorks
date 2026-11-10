using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using ApiFunctions.Auth;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Xunit;

namespace ApiFunctions.Tests;

public class AuthInventoryTests
{
    [Fact]
    public void Exports_actual_functions_and_policies_without_missing_or_stale_entries()
    {
        var functions = typeof(FunctionAuthorizationRegistry).Assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic |
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Select(method => (Method: method, Function: method.GetCustomAttribute<FunctionAttribute>()))
            .Where(item => item.Function is not null)
            .Select(item =>
            {
                var http = item.Method.GetParameters()
                    .Select(parameter => parameter.GetCustomAttribute<HttpTriggerAttribute>())
                    .FirstOrDefault(attribute => attribute is not null);
                var triggers = item.Method.GetParameters().SelectMany(parameter => parameter.GetCustomAttributes())
                    .Select(attribute => attribute.GetType().Name)
                    .Where(name => name.EndsWith("TriggerAttribute", StringComparison.Ordinal))
                    .Distinct().Order().ToArray();
                return new
                {
                    Name = item.Function!.Name,
                    Handler = $"{item.Method.DeclaringType!.FullName}.{item.Method.Name}",
                    Triggers = triggers,
                    Route = http?.Route ?? (http is null ? null : item.Function.Name),
                    Methods = http?.Methods?.Select(method => method.ToUpperInvariant()).Order().ToArray(),
                    Policy = http is null ? null : FunctionAuthorizationRegistry.Find(item.Function.Name),
                };
            }).OrderBy(item => item.Name).ToArray();

        Assert.NotEmpty(functions);
        Assert.Equal(functions.Length, functions.Select(item => item.Name).Distinct().Count());
        var httpFunctions = functions.Where(item => item.Route is not null).ToArray();
        Assert.All(httpFunctions, item =>
        {
            Assert.NotNull(item.Policy);
            Assert.NotEmpty(item.Methods ?? []);
        });
        Assert.Equal(FunctionAuthorizationRegistry.All.Count, httpFunctions.Length);
        var output = Environment.GetEnvironmentVariable("AUTH_FUNCTIONS_INVENTORY");
        if (!string.IsNullOrEmpty(output))
        {
            var options = new JsonSerializerOptions { WriteIndented = true };
            options.Converters.Add(new JsonStringEnumConverter());
            File.WriteAllText(output, JsonSerializer.Serialize(functions, options));
        }
    }
}
