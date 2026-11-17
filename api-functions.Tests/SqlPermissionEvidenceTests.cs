using Xunit;

namespace ApiFunctions.Tests;

public sealed class SqlPermissionEvidenceTests
{
    [Theory]
    [InlineData("forbidden-role")]
    [InlineData("database-admin")]
    [InlineData("schema-admin")]
    [InlineData("object-admin")]
    [InlineData("user-impersonate")]
    public void Administrative_permissions_must_be_explicitly_absent(string kind)
    {
        Assert.Equal("PASS", SqlPermissions.Evaluate(new(kind, "target", "permission", 0)).status);
        Assert.Equal("FAIL", SqlPermissions.Evaluate(new(kind, "target", "permission", 1)).status);
        Assert.Equal("BLOCKED", SqlPermissions.Evaluate(new(kind, "target", "permission", null)).status);
    }

    [Theory]
    [InlineData("required-role")]
    [InlineData("database-execute")]
    [InlineData("table-data")]
    [InlineData("routine-execute")]
    [InlineData("identity")]
    [InlineData("required-metadata")]
    public void Runtime_contract_requires_real_positive_evidence(string kind)
    {
        Assert.Equal("PASS", SqlPermissions.Evaluate(new(kind, "target", "permission", 1)).status);
        Assert.Equal("FAIL", SqlPermissions.Evaluate(new(kind, "target", "permission", 0)).status);
        Assert.Equal("BLOCKED", SqlPermissions.Evaluate(new(kind, "target", "permission", null)).status);
    }

    [Fact]
    public void Unknown_policy_or_invalid_result_cannot_become_success()
    {
        Assert.Throws<InvalidOperationException>(() => SqlPermissions.Evaluate(new("unknown", "target", "permission", 0)));
        Assert.Throws<InvalidOperationException>(() => SqlPermissions.Evaluate(new("table-data", "target", "permission", 2)));
        Assert.Contains("db_owner", SqlPermissions.ForbiddenRoles);
        Assert.Contains("db_securityadmin", SqlPermissions.ForbiddenRoles);
        Assert.DoesNotContain("IMPERSONATE ANY USER", SqlPermissions.ForbiddenDatabasePermissions);
        Assert.Contains("CONTROL", SqlPermissions.ForbiddenDatabasePermissions);
        Assert.Equal(new[] { "db_datareader", "db_datawriter" }, SqlPermissions.RequiredRoles);
    }
}
