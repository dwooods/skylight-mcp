#!/usr/bin/env node

async function main() {
  // `skylight-mcp auth ...` is a CLI, not the MCP server. Credential commands
  // are never registered as MCP tools.
  if (process.argv[2] === "auth") {
    const { runAuthCommand } = await import("./cli.js");
    process.exitCode = await runAuthCommand(process.argv.slice(3));
    return;
  }

  const { createServer } = await import("./server.js");
  const server = await createServer();
  await server.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
