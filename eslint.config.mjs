import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// Same rules as the old .eslintrc.json ("next/core-web-vitals"), in the
// flat config format ESLint 9+ needs. `next lint` was removed in Next 16.
export default defineConfig([
  ...nextVitals,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "ai/**", "storage/**", "public/**"]),
]);
