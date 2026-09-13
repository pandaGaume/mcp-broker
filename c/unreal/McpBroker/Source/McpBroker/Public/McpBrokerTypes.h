// The types an application sees: how to connect, what a slot is, and what a
// link event carries. Mirrors libmcpb's mcpb_event_t one for one, so the
// documentation in c/libmcpb/include/mcpb/mcpb_provider.h applies.

#pragma once

#include "CoreMinimal.h"
#include "McpBrokerTypes.generated.h"

/** One provider slot this process publishes. */
USTRUCT(BlueprintType)
struct MCPBROKER_API FMcpBrokerSlot
{
    GENERATED_BODY()

    /** Slot name on the broker: reachable at /<Name>/mcp. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    FString Name;

    /** Also join the broker's `_all` aggregate slot with this one. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    bool bAggregate = true;
};

/** How to reach the broker and what to publish there. */
USTRUCT(BlueprintType)
struct MCPBROKER_API FMcpBrokerConnectOptions
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    FString Host = TEXT("127.0.0.1");

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    int32 Port = 3000;

    /** wss:// is not available from this port yet; true is refused at Connect. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    bool bTls = false;

    /** Sent as X-Provider-Token when the broker has provider authentication. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    FString Token;

    /**
     * The slots this process publishes. With bMultiplex they all share ONE
     * socket on /providers; without it there must be exactly one, on its own
     * socket at /provider/<name>.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    TArray<FMcpBrokerSlot> Slots;

    /** One socket for every slot. The default, and the reason this plugin exists. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker")
    bool bMultiplex = true;

    /** Retry window floor and cap, in ms; 0 takes libmcpb's 1000 / 30000. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker|Advanced")
    int32 RetryInitialMs = 0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker|Advanced")
    int32 RetryMaxMs = 0;

    /** Keepalive ping period in ms; 0 takes libmcpb's 30000. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker|Advanced")
    int32 PingIntervalMs = 0;

    /** Largest message the link can receive, in bytes. Allocated once at Connect. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker|Advanced")
    int32 ReceiveBufferBytes = 65536;

    /** How long one poll of the socket waits before the worker checks its outbox, in ms. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Broker|Advanced")
    int32 PollMs = 100;
};

/** libmcpb's mcpb_event_type_t. */
UENUM(BlueprintType)
enum class EMcpLinkEventType : uint8
{
    /** The link is up. Connects == 1 on the first time. */
    Connected,
    /** The link WAS up and was just lost. Where an alarm belongs. */
    Disconnected,
    /** An attempt failed while already offline: the follow-up, not the incident. */
    RetryFailed,
    /** The broker refused one slot's registration; the link and the other slots stay up. */
    SlotRefused,
};

/** One link event, as libmcpb reported it, copied so it can cross threads. */
USTRUCT(BlueprintType)
struct MCPBROKER_API FMcpLinkEvent
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    EMcpLinkEventType Type = EMcpLinkEventType::Connected;

    /** libmcpb's error code, 0 for Connected. */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 ErrorCode = 0;

    /** mcpb_strerror(ErrorCode). */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    FString Error;

    /** Disconnected with a peer close: the WebSocket close code (1005 when none). */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 CloseCode = 0;

    /** RetryFailed on a refused handshake: the HTTP status (401/403 is authentication). */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 HttpStatus = 0;

    /** The peer's own words: a close reason, or the broker's refusal message. */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    FString Reason;

    /** The library's own account when it refused something (rule and header bytes). */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    FString Detail;

    /** SlotRefused: the slot's name, and the JSON-RPC code (-32000 held, -32001 forbidden). */
    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    FString Slot;

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 RpcCode = 0;

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 Attempts = 0;

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 NextRetryMs = 0;

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 DownMs = 0;

    UPROPERTY(BlueprintReadOnly, Category = "MCP Broker")
    int32 Connects = 0;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FMcpLinkEventSignature, const FMcpLinkEvent&, Event);

/**
 * Handles one incoming JSON-RPC message for a slot and returns the reply, or
 * an empty string for none (a notification). Called on the game thread by
 * default. The reply is queued back to the link.
 */
DECLARE_DELEGATE_RetVal_TwoParams(FString, FMcpMessageHandler, const FString& /*Slot*/, const FString& /*Json*/);
