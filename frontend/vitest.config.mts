import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests of pure functions (no DOM): *.test.ts next to the code
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["**/*.test.ts"], exclude: ["node_modules/**", ".next/**"] },
});
