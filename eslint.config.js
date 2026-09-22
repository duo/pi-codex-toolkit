import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
