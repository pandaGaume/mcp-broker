// See McpBrokerLink.h.

#include "McpBrokerLink.h"
#include "McpBrokerSubsystem.h"

#include "Async/Async.h"
#include "HAL/PlatformProcess.h"

DEFINE_LOG_CATEGORY_STATIC(LogMcpBroker, Log, All);

namespace
{
    TArray<uint8> Utf8Of(const FString& Text)
    {
        FTCHARToUTF8 Converter(*Text);
        TArray<uint8> Out;
        Out.Append(reinterpret_cast<const uint8*>(Converter.Get()), Converter.Length());
        Out.Add(0);
        return Out;
    }

    const char* CStr(const TArray<uint8>& Utf8)
    {
        return reinterpret_cast<const char*>(Utf8.GetData());
    }
}

FMcpBrokerLink::FMcpBrokerLink(UMcpBrokerSubsystem* InOwner, const FMcpBrokerConnectOptions& InOptions)
    : Owner(InOwner)
    , Options(InOptions)
{
    FMemory::Memzero(&PortCtx, sizeof(PortCtx));
    FMemory::Memzero(&Port, sizeof(Port));
    FMemory::Memzero(&Dedicated, sizeof(Dedicated));
    FMemory::Memzero(&Mux, sizeof(Mux));
}

FMcpBrokerLink::~FMcpBrokerLink()
{
    Shutdown();
}

bool FMcpBrokerLink::Start(FString& OutError)
{
    if (Options.bTls)
    {
        OutError = TEXT("TLS is not available from the Unreal port yet; use ws:// (bTls = false).");
        return false;
    }
    if (Options.Slots.Num() == 0)
    {
        OutError = TEXT("no slot to publish.");
        return false;
    }
    if (!Options.bMultiplex && Options.Slots.Num() != 1)
    {
        OutError = TEXT("the dedicated endpoint carries exactly one slot; set bMultiplex for several.");
        return false;
    }
    for (const FMcpBrokerSlot& Slot : Options.Slots)
    {
        if (Slot.Name.IsEmpty() || Slot.Name.Len() >= MCPB_PROVIDER_NAME_MAX)
        {
            OutError = FString::Printf(TEXT("slot name \"%s\" is empty or longer than %d."), *Slot.Name, MCPB_PROVIDER_NAME_MAX - 1);
            return false;
        }
    }

    if (mcpb_port_unreal_init(&Port, &PortCtx) != MCPB_OK)
    {
        OutError = TEXT("no socket subsystem on this platform.");
        return false;
    }

    HostUtf8 = Utf8Of(Options.Host);
    if (!Options.Token.IsEmpty())
    {
        HeadersUtf8 = Utf8Of(FString::Printf(TEXT("X-Provider-Token: %s\r\n"), *Options.Token));
    }
    for (const FMcpBrokerSlot& Slot : Options.Slots)
    {
        SlotNamesUtf8.Add(Utf8Of(Slot.Name));
    }
    for (int32 i = 0; i < Options.Slots.Num(); i++)
    {
        mcpb_mux_slot_t S;
        S.name = CStr(SlotNamesUtf8[i]);
        S.aggregate = Options.Slots[i].bAggregate ? 1 : 0;
        Slots.Add(S);
    }

    Rx.SetNumUninitialized(FMath::Max(Options.ReceiveBufferBytes, 1024));
    Tx.SetNumUninitialized(Rx.Num() + 256);

    mcpb_provider_config_t Link;
    FMemory::Memzero(&Link, sizeof(Link));
    Link.host = CStr(HostUtf8);
    Link.port = static_cast<uint16_t>(Options.Port);
    Link.tls = 0;
    Link.extra_headers = HeadersUtf8.Num() ? CStr(HeadersUtf8) : nullptr;
    Link.retry_initial_ms = static_cast<uint32_t>(FMath::Max(Options.RetryInitialMs, 0));
    Link.retry_max_ms = static_cast<uint32_t>(FMath::Max(Options.RetryMaxMs, 0));
    Link.ping_interval_ms = static_cast<uint32_t>(FMath::Max(Options.PingIntervalMs, 0));
    Link.rx_buffer = Rx.GetData();
    Link.rx_capacity = static_cast<size_t>(Rx.Num());
    Link.on_event = &FMcpBrokerLink::OnEvent;
    Link.event_user = this;

    int Rc;
    if (Options.bMultiplex)
    {
        mcpb_mux_config_t MuxConfig;
        FMemory::Memzero(&MuxConfig, sizeof(MuxConfig));
        MuxConfig.link = Link;
        MuxConfig.tx_buffer = reinterpret_cast<char*>(Tx.GetData());
        MuxConfig.tx_capacity = static_cast<size_t>(Tx.Num());
        Rc = mcpb_mux_init(&Mux, &Port, &MuxConfig, Slots.GetData(), static_cast<size_t>(Slots.Num()));
    }
    else
    {
        Link.name = Slots[0].name;
        Link.aggregate = Slots[0].aggregate;
        Rc = mcpb_provider_init(&Dedicated, &Port, &Link);
    }
    if (Rc != MCPB_OK)
    {
        OutError = FString::Printf(TEXT("libmcpb init: %s"), ANSI_TO_TCHAR(mcpb_strerror(Rc)));
        return false;
    }

    bStopRequested = false;
    Thread = FRunnableThread::Create(this, TEXT("McpBrokerLink"), 0, TPri_Normal);
    if (Thread == nullptr)
    {
        OutError = TEXT("could not create the link thread.");
        return false;
    }
    UE_LOG(LogMcpBroker, Log, TEXT("dialing ws://%s:%d%s with %d slot(s)"), *Options.Host, Options.Port,
           Options.bMultiplex ? TEXT("/providers") : TEXT("/provider/<name>"), Options.Slots.Num());
    return true;
}

void FMcpBrokerLink::Shutdown()
{
    if (Thread != nullptr)
    {
        bStopRequested = true;
        Thread->WaitForCompletion();
        delete Thread;
        Thread = nullptr;
    }
}

bool FMcpBrokerLink::Enqueue(int32 SlotIndex, const FString& Json)
{
    if (SlotIndex < 0 || SlotIndex >= Slots.Num())
    {
        return false;
    }
    FOutgoing Item;
    Item.Slot = SlotIndex;
    Item.Utf8 = Utf8Of(Json);
    Item.Utf8.Pop(); // no terminator on the wire
    Outbox.Enqueue(MoveTemp(Item));
    return true;
}

void FMcpBrokerLink::DrainOutbox()
{
    FOutgoing Item;
    while (Outbox.Dequeue(Item))
    {
        const int Rc = Options.bMultiplex
            ? mcpb_mux_send(&Mux, static_cast<size_t>(Item.Slot), CStr(Item.Utf8), static_cast<size_t>(Item.Utf8.Num()))
            : mcpb_provider_send(&Dedicated, CStr(Item.Utf8), static_cast<size_t>(Item.Utf8.Num()));
        if (Rc != MCPB_OK)
        {
            // Nothing is queued across a disconnection (mcpb_provider.h): the
            // reply answered a request carried by a link that is gone.
            UE_LOG(LogMcpBroker, Warning, TEXT("message on slot %d dropped: %s"), Item.Slot, ANSI_TO_TCHAR(mcpb_strerror(Rc)));
        }
    }
}

void FMcpBrokerLink::Deliver(int32 SlotIndex, const char* Payload, size_t Length)
{
    // Copied here, on the worker: the receive buffer is reused by the next poll.
    FUTF8ToTCHAR Converter(Payload, static_cast<int32>(Length));
    const FString Json(Converter.Length(), Converter.Get());
    TWeakObjectPtr<UMcpBrokerSubsystem> WeakOwner = Owner;
    AsyncTask(ENamedThreads::GameThread, [WeakOwner, SlotIndex, Json]()
    {
        if (UMcpBrokerSubsystem* Subsystem = WeakOwner.Get())
        {
            Subsystem->DispatchMessage(SlotIndex, Json);
        }
    });
}

uint32 FMcpBrokerLink::Run()
{
    const int PollMs = FMath::Clamp(Options.PollMs, 10, 5000);
    while (!bStopRequested)
    {
        DrainOutbox();

        const char* Msg = nullptr;
        size_t Len = 0;
        if (Options.bMultiplex)
        {
            size_t Slot = MCPB_MUX_UNKNOWN_SLOT;
            const int Rc = mcpb_mux_poll(&Mux, &Slot, &Msg, &Len, PollMs);
            if (Rc == MCPB_OK)
            {
                if (Slot == MCPB_MUX_UNKNOWN_SLOT)
                {
                    UE_LOG(LogMcpBroker, Warning, TEXT("frame for an unregistered slot ignored (%d bytes)"), static_cast<int32>(Len));
                }
                else
                {
                    Deliver(static_cast<int32>(Slot), Msg, Len);
                }
            }
            else if (Rc == MCPB_ERR_PROTOCOL)
            {
                UE_LOG(LogMcpBroker, Warning, TEXT("frame dropped: %s"), ANSI_TO_TCHAR(Mux.link.ws.detail));
            }
        }
        else
        {
            if (mcpb_provider_poll(&Dedicated, &Msg, &Len, PollMs) == MCPB_OK)
            {
                Deliver(0, Msg, Len);
            }
        }
    }

    if (Options.bMultiplex)
    {
        mcpb_mux_stop(&Mux);
    }
    else
    {
        mcpb_provider_stop(&Dedicated);
    }
    bConnected = false;
    return 0;
}

void FMcpBrokerLink::OnEvent(void* User, const mcpb_event_t* Event)
{
    FMcpBrokerLink* Self = static_cast<FMcpBrokerLink*>(User);
    const mcpb_provider_t& Link = Self->Options.bMultiplex ? Self->Mux.link : Self->Dedicated;

    Self->bConnected = (Event->type == MCPB_EVENT_CONNECTED);

    FMcpLinkEvent Copy;
    switch (Event->type)
    {
    case MCPB_EVENT_CONNECTED:    Copy.Type = EMcpLinkEventType::Connected; break;
    case MCPB_EVENT_DISCONNECTED: Copy.Type = EMcpLinkEventType::Disconnected; break;
    case MCPB_EVENT_RETRY_FAILED: Copy.Type = EMcpLinkEventType::RetryFailed; break;
    case MCPB_EVENT_SLOT_REFUSED: Copy.Type = EMcpLinkEventType::SlotRefused; break;
    }
    Copy.ErrorCode = Event->error;
    Copy.Error = ANSI_TO_TCHAR(mcpb_strerror(Event->error));
    Copy.CloseCode = Event->close_code;
    Copy.HttpStatus = Event->http_status;
    Copy.Reason = UTF8_TO_TCHAR(Event->reason);
    Copy.Detail = ANSI_TO_TCHAR(Event->detail);
    if (Event->type == MCPB_EVENT_SLOT_REFUSED && Event->slot < static_cast<size_t>(Self->Options.Slots.Num()))
    {
        Copy.Slot = Self->Options.Slots[static_cast<int32>(Event->slot)].Name;
    }
    Copy.RpcCode = Event->rpc_code;
    Copy.Attempts = static_cast<int32>(Event->attempts);
    Copy.NextRetryMs = static_cast<int32>(Event->next_retry_ms);
    Copy.DownMs = static_cast<int32>(Event->down_ms);
    Copy.Connects = static_cast<int32>(Link.connects);

    switch (Copy.Type)
    {
    case EMcpLinkEventType::Connected:
        UE_LOG(LogMcpBroker, Log, TEXT("connected (down %d ms, connection #%d)"), Copy.DownMs, Copy.Connects);
        break;
    case EMcpLinkEventType::Disconnected:
        UE_LOG(LogMcpBroker, Warning, TEXT("link lost: %s%s%s (close %d \"%s\"), retry in %d ms"), *Copy.Error,
               Copy.Detail.IsEmpty() ? TEXT("") : TEXT(": "), *Copy.Detail, Copy.CloseCode, *Copy.Reason, Copy.NextRetryMs);
        break;
    case EMcpLinkEventType::RetryFailed:
        UE_LOG(LogMcpBroker, Warning, TEXT("attempt %d failed: %s%s%s%s, retry in %d ms"), Copy.Attempts, *Copy.Error,
               Copy.HttpStatus ? TEXT(", HTTP ") : TEXT(""), Copy.HttpStatus ? *FString::FromInt(Copy.HttpStatus) : TEXT(""),
               Copy.Detail.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(": %s"), *Copy.Detail), Copy.NextRetryMs);
        break;
    case EMcpLinkEventType::SlotRefused:
        UE_LOG(LogMcpBroker, Warning, TEXT("slot \"%s\" refused by the broker (%d): %s"), *Copy.Slot, Copy.RpcCode, *Copy.Reason);
        break;
    }

    TWeakObjectPtr<UMcpBrokerSubsystem> WeakOwner = Self->Owner;
    AsyncTask(ENamedThreads::GameThread, [WeakOwner, Copy]()
    {
        if (UMcpBrokerSubsystem* Subsystem = WeakOwner.Get())
        {
            Subsystem->DispatchEvent(Copy);
        }
    });
}
