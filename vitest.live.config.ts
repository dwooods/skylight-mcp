import { defineConfig } from "vitest/config";

// Live tests run against a real Skylight frame. They are never part of the
// default `vitest run` or CI: the default config only picks up *.test.ts, and
// this config picks up only tests/live/*.live.ts. Even then every suite is a
// no-op unless SKYLIGHT_LIVE=1. See tests/live/README.md.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One file at a time: these tests share one real family calendar.
    fileParallelism: false,
  },
});
