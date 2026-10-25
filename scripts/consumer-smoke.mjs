#!/usr/bin/env node

/**
 * Packs the package as `npm publish` would, installs it into a fresh project
 * with its peers, and loads it through both `import` and `require()` — the
 * check composureCDK's module-compat package runs for its own packages.
 *
 * Run it on Node, never another runtime: a more permissive resolver would hide
 * exactly the ESM/CJS mistakes this exists to catch.
 *
 * Usage: node scripts/consumer-smoke.mjs [<package.tgz>]
 *   With a tarball (CI's Consumer job, which reuses Verify's), installs that.
 *   Without one, packs this checkout first; needs `npm run build`, since
 *   `files` ships `dist`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** Each peer at the version package-lock.json pins, so no install is needed here. */
function lockedPeers() {
  const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
  return Object.keys(manifest.peerDependencies ?? {}).map((name) => {
    const version = locked[`node_modules/${name}`]?.version;
    if (version === undefined) {
      console.error(`✗ package-lock.json pins no ${name}`);
      process.exit(1);
    }
    return `${name}@${version}`;
  });
}

const project = mkdtempSync(join(tmpdir(), "stream-dlq-consumer-"));
try {
  const tarball =
    process.argv[2] === undefined
      ? join(
          project,
          JSON.parse(run("npm", ["pack", "--json", "--pack-destination", project], root))[0]
            .filename,
        )
      : resolve(process.argv[2]);
  writeFileSync(join(project, "package.json"), '{ "private": true }\n');
  // No --legacy-peer-deps: a consumer's install enforces the peer ranges.
  run("npm", ["install", "--no-audit", "--no-fund", tarball, ...lockedPeers()], project);

  const name = manifest.name;
  run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(name)});`], project);
  run("node", ["--input-type=commonjs", "-e", `require(${JSON.stringify(name)});`], project);
  console.log(`✓ Node ${process.version}: ${name} loads through import and require().`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
