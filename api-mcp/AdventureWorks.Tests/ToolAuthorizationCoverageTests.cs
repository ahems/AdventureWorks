using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

public class ToolAuthorizationCoverageTests
{
    public static IEnumerable<object[]> Tools => ToolAuthorizationRegistry.All
        .Select(policy => new object[] { policy.Tool });

    private static CallerContext Caller(string category, string? scope, string subject = "test-subject",
        bool connectivity = true) => new()
    {
        Subject = subject, Category = category, CustomerId = 123,
        Scopes = new HashSet<string>((connectivity ? new[] { OAuthScopes.McpAccess } : [])
            .Concat(scope is null ? [] : new[] { scope }), StringComparer.Ordinal),
    };

    [Theory]
    [MemberData(nameof(Tools))]
    public void Every_tool_requires_connectivity_and_its_business_scope(string name)
    {
        var policy = ToolAuthorizationRegistry.Find(name)!;
        var evaluator = new ToolAuthorizationEvaluator();
        Assert.Equal(AuthorizationOutcome.DenyMcpAccess,
            evaluator.Evaluate(Caller("employee", policy.RequiredScope, connectivity: false),
                name, null, false).Outcome);
        Assert.Equal(AuthorizationOutcome.DenyScope,
            evaluator.Evaluate(Caller("employee", null), name, null, false).Outcome);
        Assert.True(evaluator.Evaluate(Caller("employee", policy.RequiredScope), name, null, false).Allowed);
    }

    [Theory]
    [MemberData(nameof(Tools))]
    public void Every_tool_rejects_unknown_categories_and_missing_subjects(string name)
    {
        var policy = ToolAuthorizationRegistry.Find(name)!;
        var evaluator = new ToolAuthorizationEvaluator();
        foreach (var category in new[] { "", "anonymous", "admin", "unrecognized" })
        {
            Assert.Equal(AuthorizationOutcome.DenyIdentity,
                evaluator.Evaluate(Caller(category, policy.RequiredScope), name, null, false).Outcome);
        }
        Assert.Equal(AuthorizationOutcome.DenyIdentity,
            evaluator.Evaluate(Caller("employee", policy.RequiredScope, subject: ""), name, null, false).Outcome);
    }

    [Theory]
    [MemberData(nameof(Tools))]
    public void Every_consumer_decision_matches_the_policy_and_resolved_owner(string name)
    {
        var policy = ToolAuthorizationRegistry.Find(name)!;
        var evaluator = new ToolAuthorizationEvaluator();
        var consumer = Caller("consumer", policy.RequiredScope);
        var decision = evaluator.Evaluate(consumer, name, 123, true);
        Assert.Equal(policy.Mode != ToolAccessMode.InternalOnly, decision.Allowed);
        if (policy.Mode == ToolAccessMode.SelfOrInternal)
        {
            Assert.Equal(AuthorizationOutcome.DenyOwnership,
                evaluator.Evaluate(consumer, name, 456, true).Outcome);
            Assert.Equal(123, evaluator.Evaluate(consumer, name, null, false).InjectCustomerId);
        }
    }
}
