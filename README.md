# @composure-labs/composurecdk-stream-dlq

[![Built with ComposureCDK](https://img.shields.io/badge/built%20with-ComposureCDK-0f0d0c?labelColor=b85416)](https://github.com/laazyj/composureCDK)
[![CI](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml/badge.svg)](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f0d0c)](LICENSE)

**No-loss failure capture for Lambda stream consumers, built on [composureCDK](https://github.com/laazyj/composureCDK).**

> [!WARNING]
> **Not yet usable.** Nothing is exported yet. The capture and replay APIs are fixed only after a real-account spike settles the signal topology and the encryption default. The design and the plan live in [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623).

A Lambda consuming DynamoDB Streams (and, later, Kinesis) eventually exhausts its retries on some batch. The records only live for the stream's retention window, so the failed batch has to be captured somewhere durable before that window closes, and the on-call has to hear about it with hours to spare. This package will provide:

- **Capture (always):** an S3 `onFailure` destination holding the full failed batch, plus an SQS signal queue fed by S3 event notifications. The queue gives you a native 1-minute depth gauge, and its depth and age alarms clear themselves.
- **Recovery (opt-in):** a manual-only replay function that re-invokes the processor with the captured payload, or a least-privilege grant so you can plug in your own recovery.

## Where this sits in the ecosystem

This is a **composure-labs** package: first-party, but released independently of composureCDK's lockstep `@composurecdk/*` packages. Inside the `@composure-labs` scope, the name's prefix says what a package builds on:

| Prefix          | Builds on                                      |
| --------------- | ---------------------------------------------- |
| `composurecdk-` | composureCDK's builders (and so `aws-cdk-lib`) |
| `cdk-`          | plain `aws-cdk-lib`                            |
| _(none)_        | nothing IaC-specific                           |

Community packages built on composureCDK follow the same rule under their own scope, or unscoped: `@acme/composurecdk-<name>` or `composurecdk-<name>`.

## Compatibility

| Peer              | Range                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `@composurecdk/*` | `^0.11.0`, widened as each new composureCDK minor passes this repo's CI                              |
| `aws-cdk-lib`     | `^2.184.0`, the release that added S3 on-failure destinations for DynamoDB and Kinesis event sources |
| `constructs`      | `^10.8.1`, `@composurecdk/core`'s floor                                                              |
| Node.js           | `>=20`                                                                                               |

composureCDK is pre-1.0, so `^0.11.0` means `<0.12.0`: every composureCDK minor would otherwise make this package uninstallable beside it. Dependabot widens the peer range instead (`^0.11.0 || ^0.12.0`) once CI passes against the new release. CI also tests the oldest end of every range, so a widened range stays honest. **Support policy:** the latest composureCDK minor, plus any older minor still in the range.

Ships ESM and CommonJS from one source, built by [tshy](https://github.com/isaacs/tshy), like composureCDK's own packages.

## Development

```sh
npm ci
npm run verify          # format, typecheck, lint, peer-mirror check, build, exports check, tests
npm run check:consumer  # pack, install as a consumer would, load through import and require()
```

The pre-push hook runs `verify`. See [AGENTS.md](AGENTS.md) for the rules that keep the compat loop and the dual build working.

## Releasing

Run the **Release** workflow by hand with the version to publish. It verifies, publishes to npm through trusted publishing (OIDC, with provenance), then tags and creates the GitHub Release. The version lives in the tag and on npm; `package.json` on `main` stays at `0.0.0`.

## License

[MIT](LICENSE)
