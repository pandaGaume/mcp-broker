// The sample module: one game mode, one actor, and the static echo provider
// shared with the other samples of c/, pulled in through a one-line wrapper
// (Private/static_provider.c) the same way the plugin pulls libmcpb in.

using System.IO;
using UnrealBuildTool;

public class McpBrokerSample : ModuleRules
{
    public McpBrokerSample(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // c/unreal/Sample/Source/McpBrokerSample -> four hops up is c/
        string CRoot = Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "..", ".."));
        PrivateIncludePaths.Add(Path.Combine(CRoot, "samples", "lib"));

        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "McpBroker" });
    }
}
