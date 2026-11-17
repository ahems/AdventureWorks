using Xunit;

namespace ApiFunctions.Tests;

public sealed class AddressFixtureIdentityTests
{
    private const string Run = "20261111T140000Z-87cc8764-ab20-4866-ab70-e92136a9d8e6";

    [Fact]
    public void Fixture_marker_is_stable_bounded_and_run_scoped()
    {
        var marker = AddressFixtures.Marker(Run, 7, 8);
        Assert.Equal(marker, AddressFixtures.Marker(Run, 7, 8));
        Assert.InRange(marker.Length, 1, 60);
        Assert.Equal("AuthAssurance-87cc8764ab204866ab70e92136a9d8e6", marker);
        Assert.NotEqual(marker, AddressFixtures.Marker(Run.Replace("e92136a9d8e6", "e92136a9d8e7"), 7, 8));
    }

    [Theory]
    [InlineData("", 7, 8)]
    [InlineData("invalid", 7, 8)]
    [InlineData(Run, 7, 7)]
    [InlineData(Run, 0, 8)]
    [InlineData(Run, 7, -1)]
    public void Invalid_run_or_owners_never_generate_fixture_targets(string run, int first, int second)
    {
        Assert.Throws<InvalidOperationException>(() => AddressFixtures.Marker(run, first, second));
    }
}
