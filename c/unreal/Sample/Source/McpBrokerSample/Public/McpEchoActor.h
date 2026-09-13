// The sample's whole point: one actor, two slots, one socket.
//
// On BeginPlay it asks the McpBroker subsystem to publish "ue-echo" (in
// _all) and "ue-echo-b" (not in _all) on one multiplexed socket, and serves
// both from the static echo provider shared with the host and ESP32 samples.
// A real game replaces the handler with its own JSON layer and keeps the
// rest. Every link event is logged in the same line format as the other
// samples, so the three can be compared side by side.
//
// Command line (all optional):
//   -McpBrokerHost=192.168.5.32  -McpBrokerPort=3000  -McpBrokerSlot=ue-echo
//   -McpBrokerExitAfter=60       quits the process after that many seconds,
//                               for a headless run in a script

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "McpBrokerTypes.h"
#include "McpEchoActor.generated.h"

UCLASS()
class AMcpEchoActor : public AActor
{
    GENERATED_BODY()

public:
    AMcpEchoActor();

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    UFUNCTION()
    void OnLinkEvent(const FMcpLinkEvent& Event);

    FString Handle(const FString& Slot, const FString& Json);

    TArray<char> Reply;
    FTimerHandle ExitTimer;
};
