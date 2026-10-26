import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The spike is its own package, tested with node:test (see spike/README.md).
    exclude: [...configDefaults.exclude, "spike/**"],
    testTimeout: 20_000,
    env: {
      // aws-cdk-lib >= 2.262.0 validates every synth against a default ruleset
      // (~600ms vs ~15ms per synth). The suites assert on synth output directly.
      CDK_VALIDATION: "false",
    },
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // perFile: an untested file fails on its own rather than being averaged
      // away. Matches composureCDK's packages.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 100,
        lines: 95,
        perFile: true,
      },
    },
  },
});
