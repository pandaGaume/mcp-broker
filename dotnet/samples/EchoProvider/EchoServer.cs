using System.Text.Json;

// This small MCP handler belongs to the sample. The provider library carries
// JSON-RPC messages and does not implement MCP tools or protocol negotiation.
internal sealed class EchoServer(string name)
{
    internal required Func<JsonElement, CancellationToken, ValueTask> SendAsync { get; set; }

    internal async ValueTask HandleAsync(JsonElement message, CancellationToken cancellationToken)
    {
        if (!message.TryGetProperty("id", out var id) || id.ValueKind == JsonValueKind.Null)
            return;

        var method = message.TryGetProperty("method", out var methodElement)
            ? methodElement.GetString()
            : null;
        object? result = method switch
        {
            "initialize" => new
            {
                protocolVersion = "2025-06-18",
                capabilities = new { tools = new { } },
                serverInfo = new { name, version = "0.1.0" }
            },
            "ping" => new { },
            "tools/list" => new
            {
                tools = new[]
                {
                    new
                    {
                        name = "echo",
                        description = $"Echo a message from {name}",
                        inputSchema = new
                        {
                            type = "object",
                            properties = new { message = new { type = "string" } },
                            required = new[] { "message" }
                        }
                    }
                }
            },
            "tools/call" when message.TryGetProperty("params", out var parameters)
                && parameters.TryGetProperty("name", out var toolName)
                && toolName.GetString() == "echo" => Echo(parameters),
            "resources/list" => new { resources = Array.Empty<object>() },
            "prompts/list" => new { prompts = Array.Empty<object>() },
            _ => null
        };

        // Keeping id as JsonElement preserves both its value and its JSON type.
        var response = result is null
            ? JsonSerializer.SerializeToElement(new
            {
                jsonrpc = "2.0", id,
                error = new { code = -32601, message = $"Method not found: {method}" }
            })
            : JsonSerializer.SerializeToElement(new { jsonrpc = "2.0", id, result });
        await SendAsync(response, cancellationToken);
    }

    private static object Echo(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("arguments", out var arguments)
            || !arguments.TryGetProperty("message", out var message)
            || message.ValueKind != JsonValueKind.String)
            return new { isError = true, content = new[] { new { type = "text", text = "message must be a string" } } };

        return new
        {
            content = new[] { new { type = "text", text = message.GetString()! } },
            structuredContent = new { message = message.GetString()! }
        };
    }
}
