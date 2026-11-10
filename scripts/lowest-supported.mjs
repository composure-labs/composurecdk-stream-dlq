#!/usr/bin/env node

/**
 * Prints the install specs for the *lowest* versions the peer ranges admit, and
 * for the `@composurecdk/*` devDependencies that must move with them, one per
 * line, for CI's "Lowest supported" job.
 *
 * The lockfile always resolves the newest version in range, so without this a
 * widened range (`^0.13.0 || ^0.14.0`) is only ever tested at its new end.
 *
 * - `@composurecdk/*`: the first comparator set, as a range (`^0.13.0`), so the
 *   oldest supported minor is tested at its latest patch.
 * - everything else (`aws-cdk-lib`, `constructs`): the exact lower bound
 *   (`2.184.0`). That is the declared floor, which ADR-0008 says must be proven
 *   rather than asserted.
 * - `@composurecdk/*` devDependencies that aren't peers (such as `dynamodb`,
 *   `kinesis`): their first comparator set too. Left at the newest minor, their
 *   peers would conflict with the lowered ones.
 *
 * Usage: see the `lowest-supported` job in .github/workflows/ci.yml.
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const peers = manifest.peerDependencies ?? {};
const devOnly = Object.entries(manifest.devDependencies ?? {}).filter(
  ([name]) => name.startsWith("@composurecdk/") && !(name in peers),
);

const specs = [...Object.entries(peers), ...devOnly].map(([name, range]) => {
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
