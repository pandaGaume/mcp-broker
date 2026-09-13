#include "McpBrokerSampleGameMode.h"
#include "McpEchoActor.h"
#include "Engine/World.h"

void AMcpBrokerSampleGameMode::BeginPlay()
{
    Super::BeginPlay();
    GetWorld()->SpawnActor<AMcpEchoActor>();
}
