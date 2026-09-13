using UnrealBuildTool;

public class McpBrokerSampleTarget : TargetRules
{
    public McpBrokerSampleTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("McpBrokerSample");
    }
}
