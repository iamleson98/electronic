import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // Re-enabled critical rules
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-debugger": "error",
    "no-unreachable": "error",
    "prefer-const": "warn",
    "no-empty": ["warn", { allowEmptyCatch: true }],

    // React hooks — enforce exhaustive deps for correctness
    "react-hooks/exhaustive-deps": "warn",

    // Keep some rules relaxed for this project
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "@next/next/no-img-element": "off",
  },
}, {
  // Scripts are CLI tools where console.log is the primary output mechanism.
  files: ["scripts/**/*"],
  rules: {
    "no-console": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
  },
}, {
  // Test files use relaxed rules for any/unused.
  files: ["tests/**/*", "tests-e2e/**/*"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "no-console": "off",
  },
}, {
  ignores: [
    "node_modules/**", ".next/**", "out/**", "build/**",
    "next-env.d.ts", "examples/**", "skills/**",
  ],
}];

export default eslintConfig;
