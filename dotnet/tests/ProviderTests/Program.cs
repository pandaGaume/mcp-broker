using System.Net.WebSockets;
using System.Text.Json;
using CyanMycelium.Mcp.Broker.Provider;

using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
var mode = args[0];
var endpoint = new Uri(args[1]);
var secret = Environment.GetEnvironmentVariable("MCP_PROVIDER_SECRET");
var options = new ProviderOptions { Secret = secret, Aggregate = true };
var multiplexOptions = new ProviderOptions { Secret = secret };

switch (mode)
{
    case "host":
        await RunHostAsync();
        break;
    case "refusal-direct":
        await ExpectDirectFailureAsync(false);
        break;
    case "refusal-multiplex":
        await ExpectMultiplexFailureAsync();
        break;
    case "auth-failure":
        await ExpectDirectFailureAsync(true);
        break;
    case "wire-direct":
        await RunWireAsync(false);
        break;
    case "wire-multiplex":
        await RunWireAsync(true);
        break;
    case "closed-direct":
        await ExpectDirectCloseAsync();
        break;
    case "message-bounds":
        await CheckMessageBoundsAsync();
        break;
    case "handler-failure":
        await CheckHandlerFailureAsync(false);
        break;
    case "handler-websocket-failure":
        await CheckHandlerFailureAsync(true);
        break;
    case "send-disconnect":
        await CheckInterruptedSendAsync();
        break;
    case "reconnect-direct":
        await RunReconnectAsync(false);
        break;
    case "reconnect-multiplex":
        await RunReconnectAsync(true);
        break;
    case "cancel-opening":
        await CancelOpeningAsync(false);
        break;
    case "close-opening":
        await CancelOpeningAsync(true);
        break;
    case "reconnect-disabled":
        await CheckReconnectDisabledAsync();
        break;
    default:
        throw new ArgumentException($"Unknown test mode: {mode}");
}

async Task RunHostAsync()
{
    await using var direct = new DirectTransport(new Uri(endpoint, "/provider/dotnet-direct"), options);
    var directServer = new EchoServer("dotnet-direct") { SendAsync = direct.SendAsync };
    await direct.ConnectAsync(directServer.HandleAsync, timeout.Token);

    await using var privateTransport = new DirectTransport(new Uri(endpoint, "/provider/dotnet-private"),
        new ProviderOptions { Secret = secret });
    var privateServer = new EchoServer("dotnet-private") { SendAsync = privateTransport.SendAsync };
    await privateTransport.ConnectAsync(privateServer.HandleAsync, timeout.Token);

    await using var multiplex = new MultiplexConnection(new Uri(endpoint, "/providers"), multiplexOptions);
    foreach (var name in new[] { "dotnet-mux", "dotnet-mux-private" })
    {
        var server = new EchoServer(name) { SendAsync = null! };
        var transport = multiplex.AddProvider(name, server.HandleAsync, name == "dotnet-mux");
        server.SendAsync = transport.SendAsync;
    }
    try
    {
        multiplex.AddProvider("dotnet-mux", (_, _) => ValueTask.CompletedTask);
        throw new InvalidOperationException("Duplicate local slot was accepted");
    }
    catch (ArgumentException) { }
    await multiplex.ConnectAsync(timeout.Token);

    Console.WriteLine("READY");
    var line = Console.In.ReadLineAsync(timeout.Token).AsTask();
    var finished = await Task.WhenAny(line, direct.Completion, privateTransport.Completion, multiplex.Completion);
    if (finished != line)
        await finished;
    if (await line != "stop")
        throw new InvalidOperationException("Expected stop command");
    await direct.CloseAsync(timeout.Token);
    await privateTransport.CloseAsync(timeout.Token);
    await multiplex.CloseAsync(timeout.Token);
    await Task.WhenAll(direct.Completion, privateTransport.Completion, multiplex.Completion);
    Console.WriteLine("PASS clean shutdown");
}

async Task ExpectDirectFailureAsync(bool authentication)
{
    await using var transport = new DirectTransport(endpoint, authentication ? options : options with { AutoReconnect = false });
    try
    {
        await transport.ConnectAsync((_, _) => ValueTask.CompletedTask, timeout.Token);
        await transport.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Connection was not refused");
    }
    catch (WebSocketException) when (authentication)
    {
        Console.WriteLine("PASS authentication refusal");
    }
    catch (ProviderConnectionClosedException exception) when (!authentication
        && exception.Status == WebSocketCloseStatus.PolicyViolation)
    {
        Console.WriteLine("PASS direct slot refusal");
    }
    catch (ProviderRegistrationException) when (!authentication)
    {
        Console.WriteLine("PASS direct registration refusal");
    }
}

async Task ExpectMultiplexFailureAsync()
{
    await using var connection = new MultiplexConnection(endpoint, multiplexOptions with { AutoReconnect = false });
    connection.AddProvider("dotnet-mux", (_, _) => ValueTask.CompletedTask);
    try
    {
        await connection.ConnectAsync(timeout.Token);
        await connection.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Multiplex slot was not refused");
    }
    catch (ProviderRegistrationException exception) when (exception.ProviderName == "dotnet-mux"
        && exception.Code == -32000)
    {
        Console.WriteLine("PASS multiplex slot refusal");
    }
}

async Task RunWireAsync(bool multiplexed)
{
    if (multiplexed)
    {
        await using var connection = new MultiplexConnection(endpoint, multiplexOptions with { AutoReconnect = false });
        var server = new EchoServer("wire") { SendAsync = null! };
        var transport = connection.AddProvider("wire", server.HandleAsync, aggregate: true);
        server.SendAsync = transport.SendAsync;
        await connection.ConnectAsync(timeout.Token);
        await connection.Completion.WaitAsync(timeout.Token);
    }
    else
    {
        await using var transport = new DirectTransport(endpoint, options with { AutoReconnect = false });
        var server = new EchoServer("wire") { SendAsync = transport.SendAsync };
        await transport.ConnectAsync(server.HandleAsync, timeout.Token);
        await transport.Completion.WaitAsync(timeout.Token);
    }
    Console.WriteLine("PASS wire framing");
}

async Task ExpectDirectCloseAsync()
{
    await using var transport = new DirectTransport(endpoint, options);
    try
    {
        await transport.ConnectAsync((_, _) => ValueTask.CompletedTask, timeout.Token);
        await transport.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Abnormal close was not surfaced");
    }
    catch (ProviderConnectionClosedException exception) when (exception.Status == WebSocketCloseStatus.PolicyViolation
        && exception.Description == "test refusal")
    {
        Console.WriteLine("PASS abnormal close reason");
    }
}

async Task CheckMessageBoundsAsync()
{
    await using var transport = new DirectTransport(endpoint,
        new ProviderOptions { Aggregate = true, MaxMessageBytes = 256 });
    await transport.ConnectAsync((_, _) => ValueTask.CompletedTask, timeout.Token);
    try
    {
        await transport.SendAsync(JsonSerializer.SerializeToElement(new
        {
            jsonrpc = "2.0", method = "oversized", @params = new { value = new string('x', 512) }
        }), timeout.Token);
        throw new InvalidOperationException("Oversized outgoing message was accepted");
    }
    catch (ArgumentException) { }

    // Rejecting an application send must leave this connection usable.
    await transport.SendAsync(JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", method = "ready" }), timeout.Token);
    try
    {
        await transport.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Oversized incoming message was accepted");
    }
    catch (InvalidDataException) { }
    await transport.CloseAsync(timeout.Token);
    Console.WriteLine("PASS incoming and outgoing message bounds");
}

async Task CheckHandlerFailureAsync(bool websocket)
{
    await using var transport = new DirectTransport(endpoint, new ProviderOptions { Aggregate = true });
    await transport.ConnectAsync((_, _) =>
    {
        if (websocket) throw new WebSocketException(WebSocketError.ConnectionClosedPrematurely, "handler websocket failed");
        throw new ApplicationException("handler failed");
    }, timeout.Token);
    await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(async () =>
        await transport.SendAsync(JsonSerializer.SerializeToElement(new
        {
            jsonrpc = "2.0", id = index, result = new { index, padding = new string('x', 32_768) }
        }), timeout.Token), timeout.Token)));
    try
    {
        await transport.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Handler failure was not surfaced");
    }
    catch (ApplicationException exception) when (exception.Message == "handler failed") { }
    catch (WebSocketException exception) when (websocket && exception.Message.Contains("handler websocket failed", StringComparison.Ordinal)) { }
    await transport.CloseAsync(timeout.Token);
    try
    {
        await transport.SendAsync(JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", method = "late" }), timeout.Token);
        throw new ApplicationException("A send after close was accepted");
    }
    catch (InvalidOperationException) { }
    Console.WriteLine("PASS concurrent sends, handler failure, send after close");
}

async Task CheckInterruptedSendAsync()
{
    await using var transport = new DirectTransport(endpoint, RetryOptions(aggregate: true) with { MaxMessageBytes = 8 * 1024 * 1024 });
    var server = new EchoServer("wire") { SendAsync = transport.SendAsync };
    var large = JsonSerializer.SerializeToElement(new
    {
        jsonrpc = "2.0", id = "interrupted", result = new { padding = new string('x', 4 * 1024 * 1024) }
    });
    var interrupted = false;
    await transport.ConnectAsync(async (message, token) =>
    {
        if (message.TryGetProperty("method", out var method) && method.GetString() == "interrupt-reply")
        {
            await transport.SendAsync(JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", method = "reply-start" }), token);
            // A loopback kernel may accept one large send before the peer's
            // termination arrives. Bound the writes while requiring a real
            // native-send exception, rather than assuming the first write fails.
            try
            {
                for (var attempt = 0; attempt < 16; attempt++)
                    await transport.SendAsync(large, token);
            }
            catch (WebSocketException)
            {
                interrupted = true;
                throw;
            }
        }
        else await server.HandleAsync(message, token);
    }, timeout.Token);
    Console.WriteLine("READY");
    if (await Console.In.ReadLineAsync(timeout.Token) != "stop")
        throw new InvalidOperationException("Expected stop after interrupted send recovery");
    if (!interrupted)
        throw new InvalidOperationException("The mock peer did not interrupt an actual socket send");
    if (transport.Completion.IsCompleted)
        throw new InvalidOperationException("A failed transport send ended the provider");
    await transport.CloseAsync(timeout.Token);
    await transport.Completion.WaitAsync(timeout.Token);
    Console.WriteLine("PASS reconnect after interrupted handler reply");
}

ProviderOptions RetryOptions(bool aggregate = false) => new()
{
    Secret = secret,
    Aggregate = aggregate,
    ReconnectInitialDelay = TimeSpan.FromMilliseconds(120),
    ReconnectMaxDelay = TimeSpan.FromMilliseconds(480)
};

async Task RunReconnectAsync(bool multiplexed)
{
    if (multiplexed)
    {
        await using var connection = new MultiplexConnection(endpoint, RetryOptions());
        var server = new EchoServer("wire") { SendAsync = null! };
        var transport = connection.AddProvider("wire", server.HandleAsync, aggregate: true);
        server.SendAsync = transport.SendAsync;
        var privateServer = new EchoServer("private") { SendAsync = null! };
        var privateTransport = connection.AddProvider("private", privateServer.HandleAsync);
        privateServer.SendAsync = privateTransport.SendAsync;
        await connection.ConnectAsync(timeout.Token);
        Console.WriteLine("READY");
        if (await Console.In.ReadLineAsync(timeout.Token) != "stop")
            throw new InvalidOperationException("Expected stop during retry");
        if (connection.Completion.IsCompleted)
            throw new InvalidOperationException("Completion settled during reconnect");
        await connection.CloseAsync(timeout.Token);
        await connection.Completion.WaitAsync(timeout.Token);
    }
    else
    {
        await using var transport = new DirectTransport(endpoint, RetryOptions(aggregate: true));
        var server = new EchoServer("wire") { SendAsync = transport.SendAsync };
        await transport.ConnectAsync(server.HandleAsync, timeout.Token);
        Console.WriteLine("READY");
        if (await Console.In.ReadLineAsync(timeout.Token) != "stop")
            throw new InvalidOperationException("Expected stop during retry");
        if (transport.Completion.IsCompleted)
            throw new InvalidOperationException("Completion settled during reconnect");
        await transport.CloseAsync(timeout.Token);
        await transport.Completion.WaitAsync(timeout.Token);
    }
    Console.WriteLine("PASS reconnect and explicit close during backoff");
}

async Task CancelOpeningAsync(bool close)
{
    using var openingCancellation = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
    await using var transport = new DirectTransport(endpoint, RetryOptions());
    var opening = transport.ConnectAsync((_, _) => ValueTask.CompletedTask, openingCancellation.Token);
    Console.WriteLine("READY");
    if (await Console.In.ReadLineAsync(timeout.Token) != "stop")
        throw new InvalidOperationException("Expected stop while opening");
    if (opening.IsCompleted || transport.Completion.IsCompleted)
        throw new InvalidOperationException("Connection stopped retrying before cancellation");
    if (close) await transport.CloseAsync(timeout.Token);
    else openingCancellation.Cancel();
    try
    {
        await opening.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Canceled opening completed successfully");
    }
    catch (OperationCanceledException) { }
    if (close)
        await transport.Completion.WaitAsync(timeout.Token);
    else
    {
        try
        {
            await transport.Completion.WaitAsync(timeout.Token);
            throw new InvalidOperationException("Canceled opening did not cancel Completion");
        }
        catch (OperationCanceledException) { }
    }
    Console.WriteLine("PASS canceled initial retries");
}

async Task CheckReconnectDisabledAsync()
{
    await using var transport = new DirectTransport(endpoint, RetryOptions() with { AutoReconnect = false });
    try
    {
        await transport.ConnectAsync((_, _) => ValueTask.CompletedTask, timeout.Token);
        throw new InvalidOperationException("Disabled reconnect did not fail immediately");
    }
    catch (WebSocketException) { }
    try
    {
        await transport.Completion.WaitAsync(timeout.Token);
        throw new InvalidOperationException("Completion did not preserve the connection failure");
    }
    catch (WebSocketException) { }
    Console.WriteLine("PASS disabled reconnect");
}
