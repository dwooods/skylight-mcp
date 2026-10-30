import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_EFFECTS } from "../src/tools/registry.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** Rows of the form | `tool_a` / `tool_b` | effect | ... | in the Available Tools section. */
function documentedEffects(): Map<string, string> {
  const section = readme.slice(readme.indexOf("## Available Tools"), readme.indexOf("## Example Queries"));
  const found = new Map<string, string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !cells[1]!.startsWith("`")) continue;
    const names = [...cells[1]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    for (const name of names) found.set(name, cells[2]!);
  }
  return found;
}

describe("README support matrix", () => {
  const documented = documentedEffects();

  it("documents every registered tool", () => {
    const missing = Object.keys(TOOL_EFFECTS).filter((t) => !documented.has(t));
    expect(missing, "add these tools to the README Available Tools tables").toEqual([]);
  });

  it("documents no tool that does not exist", () => {
    const extra = [...documented.keys()].filter((t) => !(t in TOOL_EFFECTS));
    expect(extra, "remove these from the README").toEqual([]);
  });

  it("states the same effect the registry enforces", () => {
    const wrong = Object.entries(TOOL_EFFECTS)
      .filter(([name, effect]) => documented.get(name) !== effect)
      .map(([name, effect]) => `${name}: registry says ${effect}, README says ${documented.get(name)}`);
    expect(wrong).toEqual([]);
  });
});
