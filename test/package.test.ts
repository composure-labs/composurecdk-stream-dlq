import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("package manifest", () => {
  it("mirrors every peer as a devDependency with the same range", () => {
    // Dependabot rewrites a peer range only when it is identical to the
    // devDependency it bumps; scripts/check-peer-mirror.mjs explains why.
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      expect(manifest.devDependencies[name], name).toBe(range);
    }
  });

  it("floors aws-cdk-lib at the release that added S3 on-failure destinations", () => {
    expect(manifest.peerDependencies["aws-cdk-lib"]).toBe("^2.184.0");
  });
});
