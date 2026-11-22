using System.Reflection;
using System.Text.RegularExpressions;
using api_functions.Functions;
using api_functions.Models;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Xunit;

namespace ApiFunctions.Tests;

/// <summary>HTTP GET routes must be pure reads; state changes use POST or the maintenance timer.</summary>
public class ReadOnlyGetRouteTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(typeof(OrderDeliveryTimerFunction), "OrderDelivery_HttpTrigger")]
    [InlineData(typeof(TransactionHistoryArchiveFunction), "ArchiveTransactionHistoryHttp")]
    [InlineData(typeof(TranslateLanguageFile), "TranslateLanguageFile_Terminate")]
    public void OnDemandJobsArePostOnly(Type type, string functionName)
    {
        var method = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Single(m => m.GetCustomAttribute<FunctionAttribute>()?.Name == functionName);
        var trigger = method.GetParameters()
            .Select(p => p.GetCustomAttribute<HttpTriggerAttribute>())
            .Single(a => a is not null)!;

        Assert.Equal(new[] { "post" }, trigger.Methods!.Select(m => m.ToLowerInvariant()));
    }

    [Fact]
    public void GetHandlersDoNotCallStateChangingHelpers()
    {
        var forbidden = new Regex(
            @"\b(InitializeAsync|EnforceAutoShutoffAsync|ListPendingWithLimitAsync|ExpirePendingAsync|PruneStaleShortagesAsync|ResetIfStaleAsync)\s*\(");
        var getTrigger = new Regex(@"\[HttpTrigger\([^\]]*""get""", RegexOptions.IgnoreCase);
        var offenders = new List<string>();

        foreach (var file in Directory.GetFiles(Path.Combine(RepoRoot(), "api-functions", "Functions"), "*.cs"))
        {
            var functions = File.ReadAllText(file).Split("[Function(");
            foreach (var body in functions.Skip(1))
            {
                if (getTrigger.IsMatch(body) && forbidden.Match(body) is { Success: true } call)
                    offenders.Add($"{Path.GetFileName(file)}: {body[..body.IndexOf(')')]} calls {call.Groups[1].Value}");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void MaintenanceTimerRunsEveryMinuteAndOnStartup()
    {
        var method = typeof(SimulationMaintenanceFunction).GetMethod(nameof(SimulationMaintenanceFunction.Run))!;
        Assert.Equal("SimulationMaintenance_Timer", method.GetCustomAttribute<FunctionAttribute>()!.Name);
        var timer = method.GetParameters().Select(p => p.GetCustomAttribute<TimerTriggerAttribute>()).Single(a => a is not null)!;
        Assert.Equal("0 * * * * *", timer.Schedule);
        Assert.True(timer.RunOnStartup);
    }

    [Theory]
    [InlineData(ManufacturingAgentMode.FullyAutonomous, -1, true)]
    [InlineData(ManufacturingAgentMode.FullyAutonomous, 0, true)]
    [InlineData(ManufacturingAgentMode.FullyAutonomous, 1, false)]
    [InlineData(ManufacturingAgentMode.Off, -1, false)]
    public void AgentConfigReadReportsShutoffWithoutPersisting(ManufacturingAgentMode mode, int minutesUntilShutoff, bool due)
    {
        var entity = new ManufacturingAgentConfigEntity { Mode = (int)mode, AutoShutoffAt = Now.AddMinutes(minutesUntilShutoff) };

        Assert.Equal(due, ManufacturingAgentConfigService.IsShutoffDue(entity, Now));
        var (effectiveMode, shutoff) = ManufacturingAgentConfigService.Effective(entity, Now);
        Assert.Equal(due ? ManufacturingAgentMode.Off : mode, effectiveMode);
        Assert.Equal(due ? null : entity.AutoShutoffAt, shutoff);
        Assert.Equal((int)mode, entity.Mode);
    }

    [Fact]
    public void AgentConfigWithoutShutoffIsNeverDue()
    {
        var entity = new ManufacturingAgentConfigEntity { Mode = (int)ManufacturingAgentMode.ReadOnly };
        Assert.False(ManufacturingAgentConfigService.IsShutoffDue(entity, Now));
    }

    [Fact]
    public void ProposalPartitionShowsNewestActiveWithinCapAndMarksTheRestStale()
    {
        // RowKey is inverted-tick, so the newest proposal has the smallest key.
        ManufacturingProposalEntity Proposal(string id, int ageMinutes) => new()
        {
            ProposalId = id,
            RowKey = $"{ageMinutes:D4}-{id}",
            CreatedAt = Now.AddMinutes(-ageMinutes),
            Status = "pending",
        };
        var expired = Proposal("expired", 10);
        var oldest = Proposal("oldest", 3);
        var middle = Proposal("middle", 2);
        var newest = Proposal("newest", 1);

        var (visible, stale) = ManufacturingProposalService.Partition(
            new[] { oldest, expired, newest, middle }, limit: 2, ttlMinutes: 5, Now);

        Assert.Equal(new[] { "newest", "middle" }, visible.Select(p => p.ProposalId));
        Assert.Equal(new[] { "expired", "oldest" }, stale.Select(p => p.ProposalId).Order());
        Assert.All(visible.Concat(stale), p => Assert.Equal("pending", p.Status));
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AdventureWorks.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Repository root not found");
    }
}
