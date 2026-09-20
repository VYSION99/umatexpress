import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { "@next/next/no-img-element": "off" } },
  // `.kilo/**` holds scratch worktrees: full copies of this repo, not source,
  // so linting them only reports every finding twice.
  globalIgnores([".next/**", "dist/**", "out/**", "build/**", "next-env.d.ts", ".kilo/**"]),
]);
