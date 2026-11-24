using System.Text.Json;

namespace CyanMycelium.Mcp.Broker.Provider;

/// <summary>Publishes one MCP server through ws[s]://host/provider/encoded-slot.</summary>
/// <remarks>
/// Carries JSON-RPC objects without an envelope. Call ConnectAsync once; transient failures reconnect
/// automatically by default. The application implements MCP and observes Completion for terminal failures.
/// </remarks>
public sealed class DirectTransport : IAsyncDisposable
{
    private readonly ProviderSocket _socket;
    private readonly bool _aggregate;

    /// <summary>Creates a direct transport. Custom path prefixes before /provider/ are supported.</summary>
    public DirectTransport(Uri endpoint, ProviderOptions? options = null)
    {
        ProviderSocket.ValidateEndpoint(endpoint);
        var path = endpoint.AbsolutePath;
        var marker = path.LastIndexOf("/provider/", StringComparison.Ordinal);
        if (marker < 0 || path[(marker + 10)..].Length == 0 || path[(marker + 10)..].Contains('/'))
            throw new ArgumentException("DirectTransport requires /provider/<encoded-slot>; /providers is multiplexed.", nameof(endpoint));
        ProviderSocket.ValidateName(Uri.UnescapeDataString(path[(marker + 10)..]));
        _aggregate = options?.Aggregate ?? false;
        _socket = new ProviderSocket(endpoint, options ?? new ProviderOptions());
    }

    /// <summary>True while the socket is ready to send. Open does not confirm broker acceptance.</summary>
    public bool IsOpen => _socket.IsOpen;

    /// <summary>Stays pending during retries; completes on shutdown or faults on a terminal failure.</summary>
    public Task Completion => _socket.Completion;

    /// <summary>Installs the handler and awaits the first open, including retries. Cancellation covers initial opening only.</summary>
    public Task ConnectAsync(ProviderMessageHandler handler, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return _socket.ConnectAsync((message, token) =>
        {
            ProviderSocket.ThrowIfRegistrationError(message, null);
            return handler(message, token);
        }, _aggregate ? [ProviderSocket.Registration(true)] : [], cancellationToken);
    }

    /// <summary>Sends a JSON-RPC object; throws if the connection is not ready. Concurrent sends are serialized.</summary>
    public ValueTask SendAsync(JsonElement message, CancellationToken cancellationToken = default)
        => _socket.SendAsync(message, cancellationToken);

    /// <summary>Closes the socket and releases the slot. Prior failures remain available through Completion.</summary>
    public Task CloseAsync(CancellationToken cancellationToken = default) => _socket.CloseAsync(cancellationToken);

    /// <summary>Closes the socket and releases connection resources.</summary>
    public ValueTask DisposeAsync() => _socket.DisposeAsync();
}
