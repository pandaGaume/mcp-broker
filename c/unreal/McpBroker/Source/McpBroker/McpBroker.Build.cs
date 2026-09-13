// McpBroker: the tunnel client to a CyanMycelium mcp-broker, for Unreal.
//
// The wire code is libmcpb, C99, the single copy in this repository under
// c/libmcpb. UBT only compiles what sits under Source/<Module>/, so
// Private/libmcpb/*.c are one-line wrappers that #include each translation
// unit; UBT compiles a .c as C, which keeps libmcpb C99 and its own warning
// set meaningful. The port over ISocketSubsystem is pulled in the same way
// from c/ports/unreal.
//
// TLS: c/ports/tls-openssl, a port over the Unreal port, compiled here against
// the OpenSSL the engine ships (the same static library the SSL and HTTP
// modules use) on the platforms where the engine has it. The engine's root
// certificates and the project's pinning come from the SSL module's
// certificate manager, added to the port's context the way CurlHttp.cpp does
// for libcurl. Elsewhere MCPB_UNREAL_TLS is 0 and bTls is refused at Connect.
//
// Layout: this file is c/unreal/McpBroker/Source/McpBroker/McpBroker.Build.cs,
// four hops up reach c/.

using System.IO;
using UnrealBuildTool;

public class McpBroker : ModuleRules
{
    public McpBroker(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        string CRoot = Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "..", ".."));

        PublicIncludePaths.Add(Path.Combine(CRoot, "libmcpb", "include"));
        PublicIncludePaths.Add(Path.Combine(CRoot, "ports", "unreal", "include"));
        PrivateIncludePaths.Add(Path.Combine(CRoot, "ports", "tls-openssl", "include"));

        // The multiplexed endpoint is the point of this plugin: one socket
        // for every server the process hosts. Built in.
        PublicDefinitions.Add("MCPB_ENABLE_MUX=1");

        // libmcpb's public functions cross the module boundary in an editor
        // build (one DLL per module). Its headers export them when
        // MCPB_BUILD_DLL is set (this module only) and import them when
        // MCPB_USE_DLL is set (every module that depends on this one; the
        // build definition takes precedence inside the module itself).
        PrivateDefinitions.Add("MCPB_BUILD_DLL=1");
        PublicDefinitions.Add("MCPB_USE_DLL=1");

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "Sockets",
            "Networking",
        });

        // Same platform set as the engine's SSL module (SSL.Build.cs).
        bool bPlatformHasOpenSsl =
            Target.Platform == UnrealTargetPlatform.Win64 ||
            Target.Platform == UnrealTargetPlatform.Mac ||
            Target.IsInPlatformGroup(UnrealPlatformGroup.Unix) ||
            Target.Platform == UnrealTargetPlatform.IOS ||
            Target.Platform == UnrealTargetPlatform.Android;
        if (bPlatformHasOpenSsl)
        {
            PrivateDefinitions.Add("MCPB_UNREAL_TLS=1");
            PrivateDependencyModuleNames.Add("SSL");
            AddEngineThirdPartyPrivateStaticDependencies(Target, "OpenSSL");
        }
        else
        {
            PrivateDefinitions.Add("MCPB_UNREAL_TLS=0");
        }
    }
}
