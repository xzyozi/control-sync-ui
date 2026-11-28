import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // ビルド前でも、パッケージ間の参照を、ソースに向ける（各パッケージの dist は、build の後に作られる）。
      "@csu/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@csu/storage-indexeddb": fileURLToPath(
        new URL("./packages/storage-indexeddb/src/index.ts", import.meta.url),
      ),
      "@csu/transport-http": fileURLToPath(
        new URL("./packages/transport-http/src/index.ts", import.meta.url),
      ),
      "@csu/relay": fileURLToPath(
        new URL("./packages/relay/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
