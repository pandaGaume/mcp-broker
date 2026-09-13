using UnrealBuildTool;

public class McpBrokerSampleEditorTarget : TargetRules
{
    public McpBrokerSampleEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("McpBrokerSample");
    }
}
