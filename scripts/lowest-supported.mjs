#!/usr/bin/env node

/**
 * Prints the install specs for the *lowest* versions the peer ranges admit, one
 * per line, for CI's "Lowest supported" job.
 *
 * The lockfile always resolves the newest version in range, so without this a
 * widened range (`^0.11.0 || ^0.12.0`) is only ever tested at its new end.
 *
 * - `@composurecdk/*`: the first comparator set, as a range (`^0.11.0`), so the
 *   oldest supported minor is tested at its latest patch.
 * - everything else (`aws-cdk-lib`, `constructs`): the exact lower bound
 *   (`2.184.0`). That is the declared floor, which ADR-0008 says must be proven
 *   rather than asserted.
 *
 * Usage: npm install --no-save $(node scripts/lowest-supported.mjs)
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const specs = Object.entries(manifest.peerDependencies ?? {}).map(([name, range]) => {
  const first = range.split("||")[0].trim();
  if (name.startsWith("@composurecdk/")) return `${name}@${first}`;
  const floor = /^[\^~>=]*\s*(\d+\.\d+\.\d+)$/.exec(first)?.[1];
  if (floor === undefined) {
    console.error(`✗ ${name}: cannot read a lower bound from "${range}"`);
    process.exit(1);
  }
  return `${name}@${floor}`;
});

console.log(specs.join("\n"));
