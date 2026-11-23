using System.Reflection;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class WorkerInvocationCompatibilityTests
{
    [Fact]
    public void GrpcInvocationCanCreateTraceContext()
    {
        var grpc = Assembly.Load("Microsoft.Azure.Functions.Worker.Grpc");
        var requestType = grpc.GetType("Microsoft.Azure.Functions.Worker.Grpc.Messages.InvocationRequest", true)!;
        var request = Activator.CreateInstance(requestType)!;
        var traceContextProperty = requestType.GetProperty("TraceContext")!;
        traceContextProperty.SetValue(request, Activator.CreateInstance(traceContextProperty.PropertyType));

        var invocationType = grpc.GetType("Microsoft.Azure.Functions.Worker.Grpc.GrpcFunctionInvocation", true)!;
        var invocation = Activator.CreateInstance(invocationType, request);

        Assert.NotNull(invocation);
        Assert.NotNull(invocationType.GetProperty("TraceContext")!.GetValue(invocation));
    }
}
