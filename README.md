# @composure-labs/composurecdk-stream-dlq

[![npm version](https://img.shields.io/npm/v/@composure-labs/composurecdk-stream-dlq)](https://www.npmjs.com/package/@composure-labs/composurecdk-stream-dlq)
[![npm downloads](https://img.shields.io/npm/dm/@composure-labs/composurecdk-stream-dlq)](https://www.npmjs.com/package/@composure-labs/composurecdk-stream-dlq)
[![Built with ComposureCDK](https://img.shields.io/badge/built%20with-ComposureCDK-0f0d0c?labelColor=b85416)](https://github.com/laazyj/composureCDK)
[![CI](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml/badge.svg)](https://github.com/composure-labs/composurecdk-stream-dlq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f0d0c)](LICENSE)

**No-loss failure capture for Lambda stream consumers, built on [composureCDK](https://github.com/laazyj/composureCDK).**

> [!WARNING]
> **Pre-release.** Capture is implemented; the narrow `s3OnFailure` grant helper, customer-managed keys and the replay function are still to come. The design is in [docs/architecture.md](docs/architecture.md), and the plan in [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623).

A Lambda consuming DynamoDB Streams (and, later, Kinesis) eventually exhausts its retries on some batch. The records only live for the stream's retention window, so the failed batch has to be captured somewhere durable before that window closes, and the on-call has to hear about it with hours to spare. This package provides:

- **Capture:** an S3 bucket for the event source mapping's on-failure destination, holding the full failed batch, and an SQS signal queue fed from the bucket through EventBridge. The queue gives you a native 1-minute depth gauge to alarm on.
- **Recovery (planned, opt-in):** a manual-only replay function that re-invokes the processor with the captured payload, or a least-privilege grant so you can plug in your own recovery.

## Getting started

```sh
npm install @composure-labs/composurecdk-stream-dlq
```

npm 7+ and pnpm 8+ install its peers for you. Add any composureCDK package your own code imports, such as `@composurecdk/core` and `@composurecdk/lambda` below, to your `package.json` as well.

Capture is a composed system you add to your own `compose` map, **in the same stack as its processor**, one capture per processor. It's a graph leaf: it never references the processor.

```ts
import { AttributeType, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Code, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { compose, ref } from "@composurecdk/core";
import { createTableV2Builder } from "@composurecdk/dynamodb";
import { createFunctionBuilder, dynamoEventSource } from "@composurecdk/lambda";
import { createStreamDlqCaptureBuilder } from "@composure-labs/composurecdk-stream-dlq";

compose(
  {
    orders: createTableV2Builder()
      .partitionKey({ name: "pk", type: AttributeType.STRING })
      .dynamoStream(StreamViewType.NEW_AND_OLD_IMAGES),

    failures: createStreamDlqCaptureBuilder(),

    processor: createFunctionBuilder()
      .runtime(Runtime.NODEJS_22_X)
      .handler("index.handler")
      .code(Code.fromAsset("lambda"))
      .addEventSource(
        "orders",
        dynamoEventSource(
          ref("orders", (r) => r.table),
          {
            startingPosition: StartingPosition.TRIM_HORIZON,
            retryAttempts: 3,
            // Planned: the narrow grant helper (architecture D8).
            onFailure: s3OnFailure(ref("failures")),
          },
        ),
      ),
  },
  { orders: [], failures: [], processor: ["orders", "failures"] },
);
```

## What capture builds

Capture is itself a composed system of four components, built under its `id` like any nested system:

| Component | What                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bucket`  | The failure bucket: versioning off, objects expire after 90 days, EventBridge on, RETAIN, SSE-S3, TLS enforced, public access blocked, and access logs to its own logs bucket    |
| `queue`   | The signal queue, in composureCDK's `"dlq"` role: 14-day retention, SSE-SQS, 1-minute visibility timeout                                                                         |
| `rule`    | An EventBridge rule on the default bus: `aws.s3` / `Object Created` / this bucket, targeting the queue, described as "Signals each stream failure written to the failure bucket" |
| `alarms`  | Capture's three alarms (below). The queue's and rule's own composureCDK alarms are off                                                                                           |

The build result returns each component as its composureCDK builder does: `result.bucket` (`bucket`, `accessLogsBucket`, `alarms`), `result.queue` (`queue`, `alarms`) and `result.rule` (`rule`, `targets`, `alarms`). `result.alarms` holds capture's alarms by key:

| Key                 | Fires when                                    | Means                                            |
| ------------------- | --------------------------------------------- | ------------------------------------------------ |
| `failuresWaiting`   | Signal queue depth > 0                        | A failure is waiting. Recover it from the bucket |
| `failuresAgeing`    | Oldest message ≥ 75% of the queue's retention | A signal is close to expiry                      |
| `signalUndelivered` | The rule's `FailedInvocations` > 0            | A failure was stored but not signalled           |

Each alarm fires on one 1-minute datapoint, with missing data not breaching. If the queue's retention is a token, the age alarm is skipped with a warning unless you set its threshold, and so is the lifetime check below.

**Keep `id` stable.** The bucket is retained and is the only copy of the data, so renaming the component orphans it and creates a new one.

**CDK adds a `BucketNotificationsHandler`** to the stack: a singleton custom-resource Lambda that switches EventBridge on at deploy. It doesn't run otherwise. On aws-cdk-lib releases before the handler's policy was scoped, its `s3:PutBucketNotification` permission is on `*`. Manage the failure bucket's notifications only through CDK, since replacing its notification configuration out of band switches the signal off.

## Customising

`.tag(key, value)` tags every resource capture creates. `.recommendedAlarms()` tunes capture's alarms: each key's config overrides the defaults field by field, `false` turns that alarm off, and `recommendedAlarms(false)` turns them all off. Each component also has a callback that receives its builder, already set up with capture's defaults:

```ts
createStreamDlqCaptureBuilder()
  .recommendedAlarms({ failuresAgeing: { evaluationPeriods: 5 } })
  .bucket((b) => b.serverAccessLogs(false))
  .queue((q) => q.retentionPeriod(Duration.days(7)))
  .rule((r) => r.description("Orders stream failures"));
```

Capture sets the signal path after your callbacks, so they can't remove it: EventBridge on the bucket, and the rule's event pattern and queue target. `build()` throws if any lifecycle rule expires objects before the queue's retention ends, since a failure would be deleted while its signal is still waiting. The age alarm's threshold follows the queue's retention. The queue's and rule's own `recommendedAlarms` are off because capture's replace them; turning them back on duplicates capture's alarms. Add any other alarm with `addAlarm` in the callback.

## Operating it

- **Configure alarm actions.** Capture creates alarms but no actions. Without them a failure alarms to nobody. Use composureCDK's `alarmActionsPolicy`, or the alarms in the result.
- **Start at `TRIM_HORIZON`, and bound retries.** With `LATEST`, composureCDK's current default, records written before a new mapping's first poll are never read, so they can never fail and be captured ([laazyj/composureCDK#635](https://github.com/laazyj/composureCDK/issues/635)). Set `retryAttempts` and `maxRecordAge` so a poison batch reaches capture with time to spare.
- **When the age alarm fires,** the signal is close to expiring. Once SQS deletes it, the alarms clear, but the object stays in the bucket until its lifecycle expiry. List the bucket to find failures older than the queue's retention.
- **When the rule's `FailedInvocations` alarm fires,** a failure was stored but not signalled. List the bucket by `LastModified` across the alarm's window to find it.
- **Before deleting the stack,** deal with outstanding failures. The bucket is retained, but the queue, the rule and the alarms go with the stack.

**Idle cost** is about $0.30 a month, almost all of it the three alarms. The queue, the rule and the handler cost nothing at rest.

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
