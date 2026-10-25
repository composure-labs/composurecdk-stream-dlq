# @composure-labs/composurecdk-stream-dlq

[![npm version](https://img.shields.io/npm/v/@composure-labs/composurecdk-stream-dlq)](https://www.npmjs.com/package/@composure-labs/composurecdk-stream-dlq)
[![npm downloads](https://img.shields.io/npm/dm/@composure-labs/composurecdk-stream-dlq)](https://www.npmjs.com/package/@composure-labs/composurecdk-stream-dlq)
[![Built with ComposureCDK](https://img.shields.io/badge/built%20with-ComposureCDK-0f0d0c?labelColor=b85416)](https://github.com/laazyj/composureCDK)
[![CI](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml/badge.svg)](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f0d0c)](LICENSE)

**No-loss failure capture for Lambda stream consumers, built on [composureCDK](https://github.com/laazyj/composureCDK).**

> [!WARNING]
> **Not yet usable.** Nothing is exported yet. The capture and replay APIs are fixed only after a real-account spike settles the signal topology and the encryption default. The design and the plan live in [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623).

A Lambda consuming DynamoDB Streams (and, later, Kinesis) eventually exhausts its retries on some batch. The records only live for the stream's retention window, so the failed batch has to be captured somewhere durable before that window closes, and the on-call has to hear about it with hours to spare. This package will provide:

- **Capture (always):** an S3 `onFailure` destination holding the full failed batch, plus an SQS signal queue fed by S3 event notifications. The queue gives you a native 1-minute depth gauge, and its depth and age alarms clear themselves.
- **Recovery (opt-in):** a manual-only replay function that re-invokes the processor with the captured payload, or a least-privilege grant so you can plug in your own recovery.

## Getting started

Install the package beside the composureCDK packages and CDK peers it builds on (the example below also uses `@composurecdk/dynamodb` for the table):

```sh
npm install @composure-labs/composurecdk-stream-dlq \
  @composurecdk/core @composurecdk/lambda @composurecdk/s3 @composurecdk/sqs \
  @composurecdk/kms @composurecdk/cloudwatch aws-cdk-lib constructs
```

> [!NOTE]
> **Planned API, not yet implemented.** The sketch below shows the intended shape from the [#623 plan](https://github.com/laazyj/composureCDK/issues/623#issuecomment-6389040288) (§2 and §3). Names and options may change once the spike reports.

Capture is a composed system you add to your own `compose` map. It's a graph leaf: it never references the processor. Recovery is opt-in, and its grants live on the replay function ([consumer-side grants](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0013-consumer-side-grants.md)).

```ts
import { AttributeType, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { compose, ref } from "@composurecdk/core";
import { createTableV2Builder } from "@composurecdk/dynamodb";
import { createFunctionBuilder, dynamoEventSource } from "@composurecdk/lambda";
import {
  createStreamDlqCapture,
  createStreamDlqReplayBuilder,
  s3OnFailure,
} from "@composure-labs/composurecdk-stream-dlq";

compose(
  {
    orders: createTableV2Builder()
      .partitionKey({ name: "pk", type: AttributeType.STRING })
      .dynamoStream(StreamViewType.NEW_AND_OLD_IMAGES),

    // Capture: failure bucket, signal queue, S3 → SQS notification, depth and age alarms.
    failures: createStreamDlqCapture(),

    processor: createFunctionBuilder()
      .runtime(Runtime.NODEJS_22_X)
      .handler("index.handler")
      .code(Code.fromAsset("lambda"))
      .addEventSource(
        "orders",
        dynamoEventSource(
          ref("orders", (r) => r.table),
          { retryAttempts: 3, onFailure: s3OnFailure(ref("failures")) },
        ),
      ),

    // Recovery (opt-in): a manual-only replay function, with no event source.
    replay: createStreamDlqReplayBuilder()
      .capture(ref("failures"))
      .target(ref("processor", (r) => r.function)),
  },
  {
    orders: [],
    failures: [],
    processor: ["orders", "failures"],
    replay: ["failures", "processor"],
  },
);
```

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the gates, the project rules and how releases work.

## License

[MIT](LICENSE)
