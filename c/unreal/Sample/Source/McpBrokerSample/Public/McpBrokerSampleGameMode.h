// Spawns the echo actor when the map starts, so the project needs no map of
// its own: the engine's Entry map plus this game mode is a running provider.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "McpBrokerSampleGameMode.generated.h"

UCLASS()
class AMcpBrokerSampleGameMode : public AGameModeBase
{
    GENERATED_BODY()

protected:
    virtual void BeginPlay() override;
};
