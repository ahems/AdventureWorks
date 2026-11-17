using api_functions.Functions;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class ShoppingSimulatorStartRequestTests
{
    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void Empty_body_uses_documented_defaults(string body)
    {
        var valid = ShoppingSimulatorStartRequest.TryParseAndValidate(body, out var request, out var error);

        Assert.True(valid);
        Assert.Empty(error);
        Assert.Equal(1, request.OrdersPerMinute);
        Assert.Equal(24, request.DurationHours);
    }

    [Theory]
    [InlineData("""{"ordersPerMinute":1,"durationHours":1,"storeOrderPercentage":5}""", 1, 1, 5)]
    [InlineData("""{"ordersPerMinute":60,"durationHours":72,"storeOrderPercentage":50}""", 60, 72, 50)]
    public void Inclusive_limits_are_accepted(string body, int rate, int duration, int storePercentage)
    {
        var valid = ShoppingSimulatorStartRequest.TryParseAndValidate(body, out var request, out var error);

        Assert.True(valid);
        Assert.Empty(error);
        Assert.Equal(rate, request.OrdersPerMinute);
        Assert.Equal(duration, request.DurationHours);
        Assert.Equal(storePercentage, request.StoreOrderPercentage);
    }

    [Theory]
    [InlineData("{", "Request body must be valid JSON.")]
    [InlineData("null", "Request body must contain a shopping simulator configuration.")]
    [InlineData("""{"ordersPerMinute":0}""", "ordersPerMinute must be between 1 and 60.")]
    [InlineData("""{"existingCustomerPercentage":101}""", "existingCustomerPercentage must be between 0 and 100.")]
    [InlineData("""{"durationHours":73}""", "durationHours must be between 1 and 72.")]
    [InlineData("""{"noOrderCustomerPercentage":-1}""", "noOrderCustomerPercentage must be between 0 and 100.")]
    [InlineData("""{"abandonedCartPercentage":101}""", "abandonedCartPercentage must be between 0 and 100.")]
    [InlineData("""{"storeOrderPercentage":4}""", "storeOrderPercentage must be between 5 and 50.")]
    [InlineData("""{"includeConsumerOrders":false,"includeStoreOrders":false}""", "At least one order type must be enabled.")]
    public void Invalid_configuration_is_rejected(string body, string expectedError)
    {
        var valid = ShoppingSimulatorStartRequest.TryParseAndValidate(body, out _, out var error);

        Assert.False(valid);
        Assert.Equal(expectedError, error);
    }
}
