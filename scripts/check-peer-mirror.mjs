#!/usr/bin/env node

/**
 * Fails unless every peerDependency is mirrored as a devDependency with the
 * *identical* range string.
 *
 * This is what keeps the compat loop working. Dependabot does not parse
 * `peerDependencies`; it rewrites a peer range only when the string equals the
 * devDependency requirement it is bumping (dependabot-core,
 * npm_and_yarn/file_updater/package_json_updater.rb). With
 * `versioning-strategy: widen`, a new composureCDK minor turns the
 * devDependency `^0.11.0` into `^0.11.0 || ^0.12.0` and carries the peer with
 * it. If the two strings ever drift apart, Dependabot keeps bumping the
 * devDependency, tests pass, and the published peer range silently stops
 * admitting new composureCDK releases. This check turns that into a red build.
 *
 * Usage: node scripts/check-peer-mirror.mjs
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const peers = manifest.peerDependencies ?? {};
const devs = manifest.devDependencies ?? {};

const problems = Object.entries(peers).flatMap(([name, range]) => {
  if (!(name in devs)) return [`${name}: peer "${range}" has no devDependency`];
  if (devs[name] !== range) return [`${name}: peer "${range}" ≠ devDependency "${devs[name]}"`];
  return [];
});

if (problems.length > 0) {
  console.error("✗ peerDependencies must be mirrored exactly in devDependencies:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`✓ ${String(Object.keys(peers).length)} peers mirrored in devDependencies.`);
