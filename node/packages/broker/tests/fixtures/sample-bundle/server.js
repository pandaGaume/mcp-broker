// Minimal stub MCP server for the .mcpb loader test fixture.
// loadMcpbBundle only resolves a StdioUpstreamConfig — it never spawns this
// file in the unit tests — so this stub just needs to exist inside the bundle.
process.stdin.resume();
