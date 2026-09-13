// The one object an application talks to: one link to the broker per game
// instance, every slot of the process on it.
//
// Threading: the socket lives on its own thread (FMcpBrokerLink, an
// FRunnable), because libmcpb polls and a game thread does not block.
// Incoming messages are handed to the slot's handler ON THE GAME THREAD, the
// handler's reply is queued back to the worker, and link events are
// broadcast on the game thread too. Send() may be called from any thread.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "McpBrokerTypes.h"
#include "McpBrokerSubsystem.generated.h"

class FMcpBrokerLink;

UCLASS()
class MCPBROKER_API UMcpBrokerSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Deinitialize() override;

    /**
     * Starts the link. Returns at once; the connection happens on the worker
     * and OnLinkEvent says when it is up. False when the options are invalid
     * (no slot, TLS asked for, a name too long, dedicated mode with several
     * slots) or when a link is already running.
     */
    UFUNCTION(BlueprintCallable, Category = "MCP Broker")
    bool Connect(const FMcpBrokerConnectOptions& Options);

    /** Closes the socket, which frees every slot on the broker, and stops the worker. */
    UFUNCTION(BlueprintCallable, Category = "MCP Broker")
    void Disconnect();

    UFUNCTION(BlueprintPure, Category = "MCP Broker")
    bool IsConnected() const;

    /**
     * Installs the handler for one slot. Native only, because it returns the
     * reply. Without a handler a slot answers nothing, and the broker fails
     * the client's request after its provider timeout.
     */
    void BindHandler(const FString& Slot, FMcpMessageHandler Handler);

    /**
     * Sends an already-serialised JSON-RPC message on a slot, from any
     * thread: queued, and written by the worker between two polls. For
     * notifications and late results. Nothing survives a disconnection.
     * Returns false when no link is running or the slot is unknown.
     */
    UFUNCTION(BlueprintCallable, Category = "MCP Broker")
    bool Send(const FString& Slot, const FString& Json);

    /** Connected, Disconnected, RetryFailed, SlotRefused. On the game thread. */
    UPROPERTY(BlueprintAssignable, Category = "MCP Broker")
    FMcpLinkEventSignature OnLinkEvent;

    // Called by the worker, through the game thread.
    void DispatchMessage(int32 SlotIndex, const FString& Json);
    void DispatchEvent(const FMcpLinkEvent& Event);

private:
    // A plain pointer on purpose: the type is only declared here, and a
    // TUniquePtr would need its destructor in this header. Disconnect owns it.
    FMcpBrokerLink* Link = nullptr;
    TArray<FString> SlotNames;
    TMap<FString, FMcpMessageHandler> Handlers;
};
