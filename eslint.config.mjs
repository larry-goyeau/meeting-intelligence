import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

/**
 * Flat config, consuming `eslint-config-next`'s own flat exports directly rather
 * than through the eslintrc compatibility shim, which does not survive ESLint 10.
 */
const config = [
  { ignores: [".next/**", "node_modules/**", ".data/**", ".tmp/**", "eval-results/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "smart"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // The CLI scripts are console programs; logging is their output.
    files: ["scripts/**/*.{ts,mjs}"],
    rules: { "no-console": "off" },
  },
];

export default config;
