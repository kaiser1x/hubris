import { defineConfig } from "vitest/config";

// Inline workspace packages so vi.mock can intercept them. By default
// Vitest externalizes node_modules (which includes the pnpm-linked
// @hubris/* workspace deps), and externalized modules cannot be mocked.
// Inlining keeps deterministic module-mock tests possible without live DB,
// model, or sandbox access. No production code is affected.
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@hubris\//],
      },
    },
  },
});
