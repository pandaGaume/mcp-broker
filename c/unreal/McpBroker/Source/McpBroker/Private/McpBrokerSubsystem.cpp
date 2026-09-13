// See McpBrokerSubsystem.h.

#include "McpBrokerSubsystem.h"
#include "McpBrokerLink.h"

DEFINE_LOG_CATEGORY_STATIC(LogMcpBrokerSubsystem, Log, All);

void UMcpBrokerSubsystem::Deinitialize()
{
    Disconnect();
    Super::Deinitialize();
}

bool UMcpBrokerSubsystem::Connect(const FMcpBrokerConnectOptions& Options)
{
    if (Link != nullptr)
    {
        UE_LOG(LogMcpBrokerSubsystem, Warning, TEXT("Connect: a link is already running; Disconnect first."));
        return false;
    }

    FMcpBrokerLink* NewLink = new FMcpBrokerLink(this, Options);
    FString Error;
    if (!NewLink->Start(Error))
    {
        UE_LOG(LogMcpBrokerSubsystem, Error, TEXT("Connect: %s"), *Error);
        delete NewLink;
        return false;
    }

    SlotNames.Reset();
    for (const FMcpBrokerSlot& Slot : Options.Slots)
    {
        SlotNames.Add(Slot.Name);
    }
    Link = NewLink;
    return true;
}

void UMcpBrokerSubsystem::Disconnect()
{
    if (Link != nullptr)
    {
        Link->Shutdown();
        delete Link;
        Link = nullptr;
    }
    SlotNames.Reset();
}

bool UMcpBrokerSubsystem::IsConnected() const
{
    return Link != nullptr && Link->IsConnected();
}

void UMcpBrokerSubsystem::BindHandler(const FString& Slot, FMcpMessageHandler Handler)
{
    Handlers.Add(Slot, MoveTemp(Handler));
}

bool UMcpBrokerSubsystem::Send(const FString& Slot, const FString& Json)
{
    if (Link == nullptr)
    {
        return false;
    }
    const int32 Index = SlotNames.IndexOfByKey(Slot);
    if (Index == INDEX_NONE)
    {
        UE_LOG(LogMcpBrokerSubsystem, Warning, TEXT("Send: slot \"%s\" is not one of this link's slots."), *Slot);
        return false;
    }
    return Link->Enqueue(Index, Json);
}

void UMcpBrokerSubsystem::DispatchMessage(int32 SlotIndex, const FString& Json)
{
    if (Link == nullptr || !SlotNames.IsValidIndex(SlotIndex))
    {
        return;
    }
    const FString& Slot = SlotNames[SlotIndex];
    const FMcpMessageHandler* Handler = Handlers.Find(Slot);
    if (Handler == nullptr || !Handler->IsBound())
    {
        UE_LOG(LogMcpBrokerSubsystem, Warning, TEXT("slot \"%s\" received a message and has no handler; the broker will time the request out."), *Slot);
        return;
    }
    const FString Reply = Handler->Execute(Slot, Json);
    if (!Reply.IsEmpty())
    {
        Link->Enqueue(SlotIndex, Reply);
    }
}

void UMcpBrokerSubsystem::DispatchEvent(const FMcpLinkEvent& Event)
{
    OnLinkEvent.Broadcast(Event);
}
