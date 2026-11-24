using System.Net.WebSockets;
using System.Text.Json;

namespace CyanMycelium.Mcp.Broker.Provider;

/// <summary>Receives a complete JSON-RPC object. Install the handler before connecting.</summary>
/// <remarks>
/// Messages are dispatched serially. Await SendAsync to reply. Do not await the connection's
/// Completion or CloseAsync inside this handler; close it from the owning application.
/// The element is detached from its parser and may be retained after the callback returns.
/// </remarks>
public delegate ValueTask ProviderMessageHandler(JsonElement message, CancellationToken cancellationToken);

/// <summary>Configuration for one WebSocket connection.</summary>
public sealed record ProviderOptions
{
    /// <summary>Opt this direct provider into _all. Multiplex providers opt in through AddProvider.</summary>
    public bool Aggregate { get; init; }

    /// <summary>Optional credential sent in the X-Provider-Token WebSocket handshake header.</summary>
    public string? Secret { get; init; }

    /// <summary>Maximum received or sent UTF-8 message size, including a multiplex envelope. Defaults to 1 MiB.</summary>
    public int MaxMessageBytes { get; init; } = 1024 * 1024;

    /// <summary>Retry transient connection failures and disconnections automatically. Defaults to true.</summary>
    public bool AutoReconnect { get; init; } = true;

    /// <summary>First retry delay. Subsequent delays double up to ReconnectMaxDelay. Defaults to one second.</summary>
    public TimeSpan ReconnectInitialDelay { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>Maximum retry delay and stable-connection reset interval. Defaults to thirty seconds.</summary>
    public TimeSpan ReconnectMaxDelay { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>A broker refused registration. Terminal refusals end the shared connection; unavailable slots may retry.</summary>
public sealed class ProviderRegistrationException : Exception
{
    /// <summary>Creates an error from a broker registration error frame.</summary>
    public ProviderRegistrationException(string? providerName, int code, string message) : base(message)
    {
        ProviderName = providerName;
        Code = code;
    }

    /// <summary>The multiplex slot that was refused, or null for a direct connection.</summary>
    public string? ProviderName { get; }

    /// <summary>The JSON-RPC error code supplied by the broker.</summary>
    public int Code { get; }
}

/// <summary>The peer closed the connection with a status other than normal closure.</summary>
public sealed class ProviderConnectionClosedException : Exception
{
    /// <summary>Creates an error preserving the peer's WebSocket status and reason.</summary>
    public ProviderConnectionClosedException(WebSocketCloseStatus? status, string? description)
        : base($"Provider connection closed ({(int?)status}): {description}")
    {
        Status = status;
        Description = description;
    }

    /// <summary>The peer's WebSocket close status, when available.</summary>
    public WebSocketCloseStatus? Status { get; }

    /// <summary>The peer's close reason, including broker refusal details.</summary>
    public string? Description { get; }
}
