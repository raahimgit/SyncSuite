import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
