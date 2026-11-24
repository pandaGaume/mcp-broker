using System.Text.Json;

namespace CyanMycelium.Mcp.Broker.Provider;

/// <summary>Publishes several MCP servers over one ws[s]://host/providers socket.</summary>
/// <remarks>
/// Add all providers before connecting. All slots share the connection lifetime and reconnect together
/// by default, with no per-slot unregister. A terminal registration refusal closes every slot.
/// </remarks>
public sealed class MultiplexConnection : IAsyncDisposable
{
    private readonly ProviderSocket _socket;
    private readonly Dictionary<string, MultiplexTransport> _providers = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private bool _started;

    /// <summary>Creates a shared connection. Set aggregate membership individually in AddProvider.</summary>
    public MultiplexConnection(Uri endpoint, ProviderOptions? options = null)
    {
        ProviderSocket.ValidateEndpoint(endpoint);
        if (!endpoint.AbsolutePath.EndsWith("/providers", StringComparison.Ordinal))
            throw new ArgumentException("MultiplexConnection requires /providers, without a slot suffix.", nameof(endpoint));
        if (options?.Aggregate == true)
            throw new ArgumentException("Set aggregate per slot using AddProvider, not on MultiplexConnection.", nameof(options));
        _socket = new ProviderSocket(endpoint, options ?? new ProviderOptions());
    }

    /// <summary>True while the shared socket is ready to send; this is not a registration acknowledgment.</summary>
    public bool IsOpen => _socket.IsOpen;

    /// <summary>Stays pending during retries; completes on shutdown or faults on a terminal failure.</summary>
    public Task Completion => _socket.Completion;

    /// <summary>Adds a slot and its handler before connecting. Aggregate membership defaults off.</summary>
    public MultiplexTransport AddProvider(string name, ProviderMessageHandler handler, bool aggregate = false)
    {
        ProviderSocket.ValidateName(name);
        ArgumentNullException.ThrowIfNull(handler);
        lock (_gate)
        {
            if (_started) throw new InvalidOperationException("Add providers before connecting.");
            var transport = new MultiplexTransport(name, handler, aggregate, _socket);
            if (!_providers.TryAdd(name, transport))
                throw new ArgumentException($"Provider '{name}' was already added.", nameof(name));
            return transport;
        }
    }

    /// <summary>Awaits the first open, including retries; every connection registers all providers before dispatching traffic.</summary>
    public Task ConnectAsync(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (_started) throw new InvalidOperationException("Each connection instance can connect only once.");
            if (_providers.Count == 0) throw new InvalidOperationException("Add at least one provider before connecting.");
            _started = true;
            var registrations = _providers.Values.Select(provider =>
                ProviderSocket.Envelope(provider.Name, ProviderSocket.Registration(provider.Aggregate))).ToArray();
            return _socket.ConnectAsync(DispatchAsync, registrations, cancellationToken);
        }
    }

    private ValueTask DispatchAsync(JsonElement envelope, CancellationToken token)
    {
        // A bare error is possible when a reverse proxy sends traffic to the wrong endpoint.
        ProviderSocket.ThrowIfRegistrationError(envelope, null);
        if (!envelope.TryGetProperty("provider", out var name) || name.ValueKind != JsonValueKind.String ||
            !envelope.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object ||
            !_providers.TryGetValue(name.GetString()!, out var provider))
            return ValueTask.CompletedTask;
        ProviderSocket.ThrowIfRegistrationError(payload, provider.Name);
        return provider.Handler(payload, token);
    }

    /// <summary>Closes the shared socket, releasing all slots. Inspect Completion for prior failures.</summary>
    public Task CloseAsync(CancellationToken cancellationToken = default) => _socket.CloseAsync(cancellationToken);

    /// <summary>Closes all slots and releases connection resources.</summary>
    public ValueTask DisposeAsync() => _socket.DisposeAsync();
}

/// <summary>A single provider's sending endpoint on a MultiplexConnection.</summary>
public sealed class MultiplexTransport
{
    private readonly ProviderSocket _socket;

    internal MultiplexTransport(string name, ProviderMessageHandler handler, bool aggregate, ProviderSocket socket)
    {
        Name = name;
        Handler = handler;
        Aggregate = aggregate;
        _socket = socket;
    }

    /// <summary>The exact broker slot name used in envelopes.</summary>
    public string Name { get; }

    internal ProviderMessageHandler Handler { get; }
    internal bool Aggregate { get; }

    /// <summary>Sends an object enveloped with this provider's name. Concurrent sends share one serialization gate.</summary>
    public ValueTask SendAsync(JsonElement message, CancellationToken cancellationToken = default)
    {
        ProviderSocket.ValidateMessage(message);
        return _socket.SendAsync(ProviderSocket.Envelope(Name, message), cancellationToken);
    }
}
