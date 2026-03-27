import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    exclude: ["src/test/live/**"],
    testTimeout: 30_000,
  },
});
