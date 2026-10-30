import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { semi: false, printWidth: 160, ignorePatterns: ["test/fixtures/**"] },
  lint: {
    ignorePatterns: ["dist/**", "test/fixtures/**"],
    options: { typeAware: true, typeCheck: true },
  },
  pack: {
    entry: ["src/index.ts", "src/plugin.ts", "src/cli.ts"],
    format: "esm",
    dts: true,
    platform: "node",
  },
  test: { include: ["test/**/*.test.ts"] },
})
