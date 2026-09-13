// The worker that owns the socket. One instance per link; libmcpb is
// single-threaded by design and this thread is the only one that touches it.
//
// In: messages from the broker, polled here and pushed to the game thread.
// Out: replies and notifications, queued by any thread and written here
// between two polls. Events: copied and pushed to the game thread.

#pragma once

#include "CoreMinimal.h"
#include "Containers/Queue.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "McpBrokerTypes.h"

#include "mcpb/mcpb_provider.h"
#include "mcpb/mcpb_mux.h"
#include "mcpb_port_unreal.h"

class UMcpBrokerSubsystem;

class FMcpBrokerLink : public FRunnable
{
public:
    FMcpBrokerLink(UMcpBrokerSubsystem* InOwner, const FMcpBrokerConnectOptions& InOptions);
    virtual ~FMcpBrokerLink() override;

    /** Validates the options and starts the thread. False with a reason in OutError. */
    bool Start(FString& OutError);

    /** Asks the thread to stop, closes the socket, joins. */
    void Shutdown();

    bool IsConnected() const { return bConnected; }

    /** From any thread. False when the slot index is out of range. */
    bool Enqueue(int32 SlotIndex, const FString& Json);

    // FRunnable
    virtual uint32 Run() override;
    virtual void Stop() override { bStopRequested = true; }

private:
    struct FOutgoing
    {
        int32 Slot;
        TArray<uint8> Utf8;
    };

    static void OnEvent(void* User, const mcpb_event_t* Event);
    void DrainOutbox();
    void Deliver(int32 SlotIndex, const char* Payload, size_t Length);

    TWeakObjectPtr<UMcpBrokerSubsystem> Owner;
    FMcpBrokerConnectOptions Options;

    // Stable UTF-8 copies of what libmcpb keeps pointers to for the whole
    // life of the link: host, token header, slot names.
    TArray<uint8> HostUtf8;
    TArray<uint8> HeadersUtf8;
    TArray<TArray<uint8>> SlotNamesUtf8;
    TArray<mcpb_mux_slot_t> Slots;

    TArray<uint8> Rx;
    TArray<uint8> Tx;

    mcpb_port_unreal_t PortCtx;
    mcpb_port_t Port;
    mcpb_provider_t Dedicated; // used when !Options.bMultiplex
    mcpb_mux_t Mux;            // used when Options.bMultiplex

    TQueue<FOutgoing, EQueueMode::Mpsc> Outbox;
    FRunnableThread* Thread = nullptr;
    TAtomic<bool> bStopRequested{false};
    TAtomic<bool> bConnected{false};
};
