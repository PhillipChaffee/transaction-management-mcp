import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".tmp_ss_probe", ".cursor"],
    testTimeout: 30_000,
  },
});
