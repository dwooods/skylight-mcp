import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { initializeClient } from "./api/client.js";
import { registerTools } from "./tools/registry.js";
import { defaultCredentialStore } from "./api/credential-store.js";

/**
 * Create and configure the MCP server
 */
export async function createServer(): Promise<{
  start: () => Promise<void>;
}> {
  // Validate configuration before starting
  const config = loadConfig();

  // Initialize client and get subscription status BEFORE tool registration
  const client = await initializeClient(config, defaultCredentialStore());
  const hasPlus = client.hasPlus();

  const server = new McpServer({
    name: "skylight",
    version: "1.0.0",
  });

  registerTools(server, { hasPlus });

  return {
    start: async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`Skylight MCP Server started (Plus: ${hasPlus})`);
    },
  };
}
