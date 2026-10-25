#!/usr/bin/env node

/**
 * Packs the package as `npm publish` would, installs it into a fresh project
 * with its peers, and loads it through both `import` and `require()` — the
 * check composureCDK's module-compat package runs for its own packages.
 *
 * Run it on Node, never another runtime: a more permissive resolver would hide
 * exactly the ESM/CJS mistakes this exists to catch. Needs `npm run build`
 * first, since `files` ships `dist`.
 *
 * Usage: node scripts/consumer-smoke.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    console.error(`✗ ${command} ${args.join(" ")} failed in ${cwd}`);
    process.exit(1);
  }
  return result.stdout;
}

/** Each peer at the version this checkout has installed. */
function installedPeers() {
  return Object.keys(manifest.peerDependencies ?? {}).map((name) => {
    const installed = JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    return `${name}@${installed.version}`;
  });
}

const project = mkdtempSync(join(tmpdir(), "stream-dlq-consumer-"));
try {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", project], root));
  writeFileSync(join(project, "package.json"), '{ "private": true }\n');
  // No --legacy-peer-deps: a consumer's install enforces the peer ranges.
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", join(project, packed.filename), ...installedPeers()],
    project,
  );

  const name = manifest.name;
  run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(name)});`], project);
  run("node", ["--input-type=commonjs", "-e", `require(${JSON.stringify(name)});`], project);
  console.log(`✓ Node ${process.version}: ${name} loads through import and require().`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
