// See McpEchoActor.h.

#include "McpEchoActor.h"
#include "McpBrokerSubsystem.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "TimerManager.h"

extern "C"
{
#include "static_provider.h"
}

DEFINE_LOG_CATEGORY_STATIC(LogMcpEcho, Log, All);

AMcpEchoActor::AMcpEchoActor()
{
    PrimaryActorTick.bCanEverTick = false;
    Reply.SetNumUninitialized(8192);
}

void AMcpEchoActor::BeginPlay()
{
    Super::BeginPlay();

    UMcpBrokerSubsystem* Broker = GetGameInstance()->GetSubsystem<UMcpBrokerSubsystem>();
    if (Broker == nullptr)
    {
        UE_LOG(LogMcpEcho, Error, TEXT("McpBroker subsystem not found: is the plugin enabled?"));
        return;
    }

    FMcpBrokerConnectOptions Options;
    FParse::Value(FCommandLine::Get(), TEXT("McpBrokerHost="), Options.Host);
    FParse::Value(FCommandLine::Get(), TEXT("McpBrokerPort="), Options.Port);
    FString SlotName = TEXT("ue-echo");
    FParse::Value(FCommandLine::Get(), TEXT("McpBrokerSlot="), SlotName);
    Options.bTls = FParse::Param(FCommandLine::Get(), TEXT("McpBrokerTls"));
    FString CaPath;
    if (FParse::Value(FCommandLine::Get(), TEXT("McpBrokerCa="), CaPath) && !CaPath.IsEmpty())
    {
        if (!FFileHelper::LoadFileToString(Options.CaPem, *CaPath))
        {
            UE_LOG(LogMcpEcho, Error, TEXT("-McpBrokerCa=%s: cannot read"), *CaPath);
            return;
        }
        Options.bTls = true;
    }

    FMcpBrokerSlot A;
    A.Name = SlotName;
    A.bAggregate = true;
    FMcpBrokerSlot B;
    B.Name = SlotName + TEXT("-b");
    B.bAggregate = false;
    Options.Slots = { A, B };
    Options.bMultiplex = true;
    Options.RetryInitialMs = 500;

    Broker->BindHandler(A.Name, FMcpMessageHandler::CreateUObject(this, &AMcpEchoActor::Handle));
    Broker->BindHandler(B.Name, FMcpMessageHandler::CreateUObject(this, &AMcpEchoActor::Handle));
    Broker->OnLinkEvent.AddDynamic(this, &AMcpEchoActor::OnLinkEvent);

    if (!Broker->Connect(Options))
    {
        UE_LOG(LogMcpEcho, Error, TEXT("Connect refused; see the McpBroker log above."));
        return;
    }
    UE_LOG(LogMcpEcho, Log, TEXT("publishing %s (in _all) and %s on one socket to %s://%s:%d/providers"),
           *A.Name, *B.Name, Options.bTls ? TEXT("wss") : TEXT("ws"), *Options.Host, Options.Port);

    int32 ExitAfter = 0;
    if (FParse::Value(FCommandLine::Get(), TEXT("McpBrokerExitAfter="), ExitAfter) && ExitAfter > 0)
    {
        GetWorld()->GetTimerManager().SetTimer(ExitTimer, [this]()
        {
            UE_LOG(LogMcpEcho, Log, TEXT("exit timer elapsed, quitting"));
            UKismetSystemLibrary::QuitGame(this, nullptr, EQuitPreference::Quit, false);
        }, static_cast<float>(ExitAfter), false);
    }
}

void AMcpEchoActor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (UMcpBrokerSubsystem* Broker = GameInstance->GetSubsystem<UMcpBrokerSubsystem>())
        {
            Broker->Disconnect();
        }
    }
    Super::EndPlay(EndPlayReason);
}

FString AMcpEchoActor::Handle(const FString& Slot, const FString& Json)
{
    // Same static surface as the other samples: initialize, ping, tools/list,
    // tools/call echo. The slot name is what the echo prefixes.
    FTCHARToUTF8 SlotUtf8(*Slot);
    FTCHARToUTF8 JsonUtf8(*Json);

    char Method[64];
    static_provider_method(JsonUtf8.Get(), static_cast<size_t>(JsonUtf8.Length()), Method, sizeof(Method));
    UE_LOG(LogMcpEcho, Log, TEXT("rx %s %s (%d bytes)"), *Slot, ANSI_TO_TCHAR(Method), JsonUtf8.Length());

    const int Len = static_provider_handle(SlotUtf8.Get(), JsonUtf8.Get(), static_cast<size_t>(JsonUtf8.Length()),
                                           Reply.GetData(), static_cast<size_t>(Reply.Num()));
    if (Len <= 0)
    {
        return FString();
    }
    FUTF8ToTCHAR Converter(Reply.GetData(), Len);
    return FString(Converter.Length(), Converter.Get());
}

void AMcpEchoActor::OnLinkEvent(const FMcpLinkEvent& Event)
{
    switch (Event.Type)
    {
    case EMcpLinkEventType::Connected:
        UE_LOG(LogMcpEcho, Log, TEXT("event CONNECTED down_ms=%d connects=%d"), Event.DownMs, Event.Connects);
        break;
    case EMcpLinkEventType::Disconnected:
        UE_LOG(LogMcpEcho, Warning, TEXT("event DISCONNECTED error=\"%s\" code=%d reason=\"%s\" detail=\"%s\" next_retry_ms=%d"),
               *Event.Error, Event.CloseCode, *Event.Reason, *Event.Detail, Event.NextRetryMs);
        break;
    case EMcpLinkEventType::RetryFailed:
        UE_LOG(LogMcpEcho, Warning, TEXT("event RETRY_FAILED error=\"%s\" http_status=%d detail=\"%s\" attempts=%d next_retry_ms=%d"),
               *Event.Error, Event.HttpStatus, *Event.Detail, Event.Attempts, Event.NextRetryMs);
        break;
    case EMcpLinkEventType::SlotRefused:
        UE_LOG(LogMcpEcho, Warning, TEXT("event SLOT_REFUSED slot=%s code=%d reason=\"%s\""), *Event.Slot, Event.RpcCode, *Event.Reason);
        break;
    }
}
