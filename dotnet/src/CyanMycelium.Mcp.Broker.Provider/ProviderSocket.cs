using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.ExceptionServices;
using System.Security.Authentication;
using System.Text.Json;

namespace CyanMycelium.Mcp.Broker.Provider;

// A supervisor owns each socket generation, its registration and its receive loop.
internal sealed class ProviderSocket : IAsyncDisposable
{
    private sealed class Session : IDisposable
    {
        internal readonly ClientWebSocket Socket = new();
        internal readonly CancellationTokenSource Lifetime = new();
        internal readonly ConcurrentDictionary<Exception, byte> SendFailures = new(ReferenceEqualityComparer.Instance);

        public void Dispose()
        {
            try { Lifetime.Cancel(); }
            finally
            {
                Socket.Abort();
                Socket.Dispose();
                Lifetime.Dispose();
            }
        }
    }

    // Application exceptions must not be retried merely because they have a socket exception type.
    private sealed class MessageHandlerException(Exception inner) : Exception("Provider handler failed.", inner);

    private readonly Uri _endpoint;
    private readonly ProviderOptions _options;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly TaskCompletionSource _firstOpen = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _sessionGate = new();
    private readonly object _closeGate = new();
    private Session? _session;
    private Task? _closeTask;
    private int _started;
    private int _ready;
    private int _closing;
    private int _disposed;

    internal ProviderSocket(Uri endpoint, ProviderOptions options)
    {
        if (options.MaxMessageBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(options), "MaxMessageBytes must be positive.");
        if (options.ReconnectInitialDelay <= TimeSpan.Zero || options.ReconnectMaxDelay < options.ReconnectInitialDelay ||
            options.ReconnectMaxDelay.TotalMilliseconds > uint.MaxValue - 1)
            throw new ArgumentOutOfRangeException(nameof(options), "Retry delays must be positive, initial <= maximum, and maximum <= 4294967294 ms.");
        _endpoint = endpoint;
        _options = options;
    }

    internal bool IsOpen => Volatile.Read(ref _ready) == 1 && Volatile.Read(ref _session)?.Socket.State == WebSocketState.Open;
    internal Task Completion => _completion.Task;

    internal static void ValidateEndpoint(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (!endpoint.IsAbsoluteUri || (endpoint.Scheme != "ws" && endpoint.Scheme != "wss") || endpoint.Fragment.Length > 0)
            throw new ArgumentException("An absolute ws:// or wss:// provider URL without a fragment is required.", nameof(endpoint));
    }

    internal static void ValidateName(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        if (name is "_broker" or "_all")
            throw new ArgumentException($"Provider '{name}' is reserved by the broker.", nameof(name));
    }

    internal static void ValidateMessage(JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("A JSON-RPC object is required.", nameof(message));
    }

    internal static JsonElement Registration(bool aggregate) => aggregate
        ? JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", method = "notifications/register", @params = new { aggregate = true } })
        : JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", method = "notifications/register" });

    internal static JsonElement Envelope(string provider, JsonElement payload)
        => JsonSerializer.SerializeToElement(new { provider, payload });

    internal static void ThrowIfRegistrationError(JsonElement message, string? provider)
    {
        if (message.TryGetProperty("id", out var id) && id.ValueKind != JsonValueKind.Null) return;
        if (message.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object &&
            error.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.Number && code.TryGetInt32(out var value) &&
            error.TryGetProperty("message", out var text) && text.ValueKind == JsonValueKind.String)
            throw new ProviderRegistrationException(provider, value, text.GetString()!);
    }

    internal Task ConnectAsync(ProviderMessageHandler handler, JsonElement[] registrations, CancellationToken token)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (Interlocked.CompareExchange(ref _started, 1, 0) != 0 || Volatile.Read(ref _closing) != 0)
            throw new InvalidOperationException("Call ConnectAsync once per instance; reconnection is managed automatically.");
        _ = RunAsync(handler, registrations, token);
        return _firstOpen.Task;
    }

    private async Task RunAsync(ProviderMessageHandler handler, JsonElement[] registrations, CancellationToken initialToken)
    {
        Exception? failure = null;
        var openedOnce = false;
        using var initial = CancellationTokenSource.CreateLinkedTokenSource(initialToken, _stop.Token);
        var delay = _options.ReconnectInitialDelay;
        try
        {
            while (Volatile.Read(ref _closing) == 0)
            {
                var attemptToken = openedOnce ? _stop.Token : initial.Token;
                attemptToken.ThrowIfCancellationRequested();
                Session session;
                lock (_sessionGate)
                {
                    if (_closing != 0) break;
                    session = new Session();
                    session.Socket.Options.CollectHttpResponseDetails = true;
                    if (_options.Secret is not null)
                        session.Socket.Options.SetRequestHeader("X-Provider-Token", _options.Secret);
                    _session = session;
                }

                var retry = false;
                Exception? sessionFailure = null;
                long? openedAt = null;
                try
                {
                    using var opening = CancellationTokenSource.CreateLinkedTokenSource(attemptToken, session.Lifetime.Token);
                    await session.Socket.ConnectAsync(_endpoint, opening.Token).ConfigureAwait(false);
                    // All registrations precede sends and receive callbacks on every new socket.
                    foreach (var registration in registrations)
                        await SendFrameAsync(session, registration, opening.Token).ConfigureAwait(false);
                    opening.Token.ThrowIfCancellationRequested();
                    lock (_sessionGate)
                    {
                        _stop.Token.ThrowIfCancellationRequested();
                        Volatile.Write(ref _ready, 1);
                        openedOnce = true;
                        openedAt = Stopwatch.GetTimestamp();
                        _firstOpen.TrySetResult();
                    }
                    await ReceiveLoopAsync(session, handler).ConfigureAwait(false);
                    retry = _options.AutoReconnect;
                }
                catch (MessageHandlerException error)
                {
                    sessionFailure = error.InnerException!;
                    retry = _options.AutoReconnect &&
                        (sessionFailure is ProviderRegistrationException { Code: -32000 } ||
                         session.SendFailures.ContainsKey(sessionFailure) && IsTransient(sessionFailure, session.Socket.HttpStatusCode));
                }
                catch (Exception error)
                {
                    sessionFailure = error;
                    retry = _options.AutoReconnect && IsTransient(error, session.Socket.HttpStatusCode);
                }
                finally
                {
                    lock (_sessionGate)
                    {
                        Volatile.Write(ref _ready, 0);
                        _session = null;
                    }
                    session.Dispose();
                }

                if (Volatile.Read(ref _closing) != 0) break;
                if (!openedOnce) initial.Token.ThrowIfCancellationRequested();
                if (!retry)
                {
                    if (sessionFailure is not null) ExceptionDispatchInfo.Capture(sessionFailure).Throw();
                    break;
                }

                // Opening alone is not proof of a healthy link. Short sessions keep the growing delay.
                if (openedAt is { } timestamp && Stopwatch.GetElapsedTime(timestamp) >= _options.ReconnectMaxDelay)
                    delay = _options.ReconnectInitialDelay;
                await Task.Delay(delay, openedOnce ? _stop.Token : initial.Token).ConfigureAwait(false);
                delay = TimeSpan.FromTicks(delay.Ticks >= _options.ReconnectMaxDelay.Ticks / 2
                    ? _options.ReconnectMaxDelay.Ticks : delay.Ticks * 2);
            }
        }
        catch (Exception error) { failure = error; }
        finally
        {
            Volatile.Write(ref _ready, 0);
            if (Volatile.Read(ref _closing) != 0)
            {
                _firstOpen.TrySetCanceled(_stop.Token);
                _completion.TrySetResult();
            }
            else if (!openedOnce && initialToken.IsCancellationRequested)
            {
                _firstOpen.TrySetCanceled(initialToken);
                _completion.TrySetCanceled(initialToken);
            }
            else if (failure is not null)
            {
                _firstOpen.TrySetException(failure);
                _completion.TrySetException(failure);
            }
            else
            {
                _firstOpen.TrySetCanceled();
                _completion.TrySetResult();
            }
        }
    }

    private static bool IsTransient(Exception error, HttpStatusCode status)
    {
        if (error is ProviderConnectionClosedException closed)
        {
            if (closed.Status == WebSocketCloseStatus.PolicyViolation)
                return closed.Description?.StartsWith("Slot already held by a live provider", StringComparison.Ordinal) == true;
            return (int?)closed.Status is null or 1000 or 1001 or 1005 or 1006 or 1011 or 1012 or 1013 or 1014;
        }
        if (error is not WebSocketException) return false;
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
            if (cause is AuthenticationException) return false;
        // Upgrade refusals carry structured status codes, including provider authentication failures.
        var code = (int)status;
        return code is 0 or 101 or 408 or 429 || code >= 500;
    }

    internal ValueTask SendAsync(JsonElement message, CancellationToken token)
    {
        ValidateMessage(message);
        var session = Volatile.Read(ref _session);
        if (session is null || !IsOpen || Volatile.Read(ref _closing) != 0)
            throw new InvalidOperationException("The provider connection is not open.");
        return SendFrameAsync(session, message, token);
    }

    private async ValueTask SendFrameAsync(Session session, JsonElement message, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        if (bytes.Length > _options.MaxMessageBytes)
            throw new ArgumentException($"Message exceeds MaxMessageBytes ({_options.MaxMessageBytes}).", nameof(message));
        using var sending = CancellationTokenSource.CreateLinkedTokenSource(token, session.Lifetime.Token);
        await _sendGate.WaitAsync(sending.Token).ConfigureAwait(false);
        try
        {
            // A send belongs to the socket captured before waiting, never to its replacement.
            if (!ReferenceEquals(Volatile.Read(ref _session), session) || Volatile.Read(ref _closing) != 0 ||
                session.Socket.State != WebSocketState.Open)
                throw new InvalidOperationException("The provider connection is not open.");
            try
            {
                await session.Socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, sending.Token).ConfigureAwait(false);
            }
            catch (WebSocketException error)
            {
                session.SendFailures.TryAdd(error, 0);
                throw;
            }
        }
        finally { _sendGate.Release(); }
    }

    private async Task ReceiveLoopAsync(Session session, ProviderMessageHandler handler)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            using var message = new MemoryStream();
            while (!session.Lifetime.IsCancellationRequested)
            {
                var result = await session.Socket.ReceiveAsync(buffer.AsMemory(), session.Lifetime.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var status = session.Socket.CloseStatus;
                    var description = session.Socket.CloseStatusDescription;
                    Volatile.Write(ref _ready, 0);
                    try { await AcknowledgeCloseAsync(session).ConfigureAwait(false); }
                    catch (Exception) when (status != WebSocketCloseStatus.NormalClosure)
                    {
                        throw new ProviderConnectionClosedException(status, description);
                    }
                    if (status != WebSocketCloseStatus.NormalClosure)
                        throw new ProviderConnectionClosedException(status, description);
                    return;
                }
                if (result.MessageType != WebSocketMessageType.Text)
                    throw new InvalidDataException("Provider tunnels require WebSocket text messages.");
                if (message.Length + result.Count > _options.MaxMessageBytes)
                    throw new InvalidDataException($"Received message exceeds MaxMessageBytes ({_options.MaxMessageBytes}).");
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;

                JsonElement payload;
                try
                {
                    using var parsed = JsonDocument.Parse(message.GetBuffer().AsMemory(0, checked((int)message.Length)));
                    payload = parsed.RootElement.Clone();
                }
                catch (JsonException)
                {
                    message.SetLength(0);
                    continue;
                }
                message.SetLength(0);
                if (payload.ValueKind == JsonValueKind.Object)
                {
                    try { await handler(payload, session.Lifetime.Token).ConfigureAwait(false); }
                    catch (Exception error) { throw new MessageHandlerException(error); }
                }
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private async Task AcknowledgeCloseAsync(Session session)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await _sendGate.WaitAsync(timeout.Token).ConfigureAwait(false);
        try
        {
            if (session.Socket.State == WebSocketState.CloseReceived)
                await session.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token).ConfigureAwait(false);
        }
        finally { _sendGate.Release(); }
    }

    internal Task CloseAsync(CancellationToken token)
    {
        Task closing;
        lock (_closeGate) closing = _closeTask ??= CloseCoreAsync();
        return token.CanBeCanceled ? closing.WaitAsync(token) : closing;
    }

    private async Task CloseCoreAsync()
    {
        Session? session;
        lock (_sessionGate)
        {
            Volatile.Write(ref _closing, 1);
            Volatile.Write(ref _ready, 0);
            session = _session;
        }
        // Disarm retry delays and in-progress opens before awaiting the graceful close.
        _stop.Cancel();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            if (session?.Socket.State == WebSocketState.Open)
            {
                await _sendGate.WaitAsync(timeout.Token).ConfigureAwait(false);
                try
                {
                    if (session.Socket.State == WebSocketState.Open)
                        await session.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token).ConfigureAwait(false);
                }
                finally { _sendGate.Release(); }
            }
            if (Volatile.Read(ref _started) != 0)
                await Completion.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or InvalidOperationException)
        {
            // A peer that never acknowledges must not hold shutdown indefinitely.
        }
        catch (Exception) when (Completion.IsFaulted)
        {
            // Prior terminal failures remain observable through Completion.
        }
        finally
        {
            lock (_sessionGate)
            {
                if (_session is { } active)
                {
                    active.Lifetime.Cancel();
                    active.Socket.Abort();
                }
            }
            _firstOpen.TrySetCanceled(_stop.Token);
            _completion.TrySetResult();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync(CancellationToken.None).ConfigureAwait(false);
        Interlocked.Exchange(ref _disposed, 1);
    }
}
