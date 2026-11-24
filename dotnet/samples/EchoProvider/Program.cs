using CyanMycelium.Mcp.Broker.Provider;

var multiplex = args.Contains("--multiplex");
var aggregate = args.Contains("--aggregate");
var endpointArgument = args.FirstOrDefault(argument => !argument.StartsWith("--", StringComparison.Ordinal));
var endpoint = new Uri(endpointArgument ?? (multiplex
    ? "ws://localhost:3000/providers"
    : "ws://localhost:3000/provider/dotnet-echo"));
var options = new ProviderOptions
{
    Aggregate = !multiplex && aggregate,
    Secret = Environment.GetEnvironmentVariable("MCP_PROVIDER_SECRET")
};

var stop = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var openingCancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    stop.TrySetResult();
    openingCancellation.Cancel();
};

try
{
    await RunAsync();
}
catch (OperationCanceledException) when (openingCancellation.IsCancellationRequested) { }

async Task RunAsync()
{
    if (multiplex)
    {
        await using var connection = new MultiplexConnection(endpoint, options);
        foreach (var name in new[] { "dotnet-echo", "dotnet-second" })
        {
            var server = new EchoServer(name) { SendAsync = null! };
            var transport = connection.AddProvider(name, server.HandleAsync, aggregate);
            server.SendAsync = transport.SendAsync;
        }
        await connection.ConnectAsync(openingCancellation.Token);
        Console.WriteLine("WebSocket opened for dotnet-echo and dotnet-second. Press Enter or Ctrl+C to stop.");
        await WaitForStopAsync(connection.Completion);
        await connection.CloseAsync();
    }
    else
    {
        await using var transport = new DirectTransport(endpoint, options);
        var server = new EchoServer("dotnet-echo") { SendAsync = transport.SendAsync };
        await transport.ConnectAsync(server.HandleAsync, openingCancellation.Token);
        Console.WriteLine("WebSocket opened. Press Enter or Ctrl+C to stop.");
        await WaitForStopAsync(transport.Completion);
        await transport.CloseAsync();
    }
}

async Task WaitForStopAsync(Task completion)
{
    var finished = await Task.WhenAny(completion, stop.Task, Console.In.ReadLineAsync());
    // Completion reports delayed broker refusals and abnormal disconnections.
    if (finished == completion)
        await completion;
}
