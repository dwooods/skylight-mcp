import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_EFFECTS, annotationsFor, registerTools, selectedTools } from "../src/tools/registry.js";

function names(server: McpServer): Record<string, { annotations?: Record<string, unknown> }> {
  // _registeredTools is private API, but it's the only way to read back annotations without a transport.
  return (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
}

describe("tool registry", () => {
  it("registers every classified tool for a Plus account with default options", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registered = registerTools(server, { hasPlus: true });
    expect(registered.sort()).toEqual(Object.keys(TOOL_EFFECTS).sort());
  });

  it("attaches annotations derived from the effect", () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { hasPlus: true });
    const tools = names(server);
    expect(tools.get_calendar_events.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.create_calendar_event.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.delete_calendar_event.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("hosted profile: read + write only, no deletes, no photos", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registered = registerTools(server, { hasPlus: true, effects: ["read", "write"], photos: false });
    expect(registered.some((n) => n.startsWith("delete_"))).toBe(false);
    expect(registered).not.toContain("get_albums");
    expect(registered).toContain("create_calendar_event");
    expect(registered).toContain("get_calendar_events");
  });

  it("hides Plus tools for free accounts", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registered = registerTools(server, { hasPlus: false });
    for (const n of ["get_rewards", "get_recipes", "get_albums"]) expect(registered).not.toContain(n);
    expect(registered).toContain("get_chores");
  });

  it("selectedTools matches what gets registered", () => {
    expect(selectedTools({ hasPlus: true, effects: ["destructive"] }).every((n) => n.startsWith("delete_"))).toBe(true);
  });

  it("annotationsFor is total", () => {
    expect(annotationsFor("read").readOnlyHint).toBe(true);
    expect(annotationsFor("write").idempotentHint).toBe(false);
  });
});
