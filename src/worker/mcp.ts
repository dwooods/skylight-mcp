/**
 * One MCP request = one fresh McpServer bound to the grant's Skylight
 * credential. Stateless Streamable HTTP: no sessions, no Durable Objects.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../api/client.js";
import { runWithContext } from "../context.js";
import { registerTools, type ToolEffect } from "../tools/registry.js";
import type { SkylightProps } from "./props.js";

/** The hosted server never deletes and never uploads photos. */
export const HOSTED_EFFECTS: readonly ToolEffect[] = ["read", "write"];

export async function handleMcpRequest(request: Request, props: SkylightProps, version: string): Promise<Response> {
  const config = { frameId: props.frameId, timezone: props.timezone, token: props.accessToken, authType: "bearer" as const };
  const client = new SkylightClient(config, null);

  const server = new McpServer({ name: "skylight", version });
  registerTools(server, { hasPlus: props.hasPlus, effects: HOSTED_EFFECTS, photos: false });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await runWithContext({ client, config }, () => transport.handleRequest(request));
  } finally {
    await transport.close().catch(() => undefined);
  }
}
