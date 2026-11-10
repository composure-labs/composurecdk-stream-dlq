import { type App, CfnOutput, Stack } from "aws-cdk-lib";
import { AttributeType, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Code, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { BucketEncryption } from "aws-cdk-lib/aws-s3";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { compose, type Ref, ref } from "@composurecdk/core";
import { createTableV2Builder, type TableV2BuilderResult } from "@composurecdk/dynamodb";
import { createStreamBuilder, type StreamBuilderResult } from "@composurecdk/kinesis";
import { createKeyBuilder, type KeyBuilderResult } from "@composurecdk/kms";
import {
  type ComposureEventSource,
  createFunctionBuilder,
  dynamoEventSource,
  type IFunctionBuilder,
  kinesisEventSource,
} from "@composurecdk/lambda";
import {
  createStreamDlqCaptureBuilder,
  s3OnFailure,
  type StreamDlqCaptureResult,
} from "@composure-labs/composurecdk-stream-dlq";

/**
 * The deploy test's stack name. The sandbox role scopes most of its
 * permissions to resources named from it (see
 * .github/cloudformation/github-oidc-role.yml). It is short so that the
 * prefix survives CloudFormation truncating a generated name to fit a
 * service's limit.
 */
export const STACK_NAME = "ComposureLabs-StreamDlq-Test";

/**
 * The Kinesis stream's name. Set explicitly, from the stack name, because the
 * sandbox role's `kinesis:PutRecord` is scoped to streams with that prefix.
 */
const EVENTS_STREAM_NAME = `${STACK_NAME}-events`;

/** The stack outputs `run.ts` reads. */
export const OUTPUTS = [
  "TableName",
  "FunctionName",
  "BucketName",
  "QueueUrl",
  "AlarmName",
  "KeyedFunctionName",
  "KeyedBucketName",
  "KeyedQueueUrl",
  "StreamName",
  "KinesisFunctionName",
  "KinesisBucketName",
  "KinesisQueueUrl",
] as const;
export type Outputs = Record<(typeof OUTPUTS)[number], string>;

/** Read from the start, and send a failure to `capture` on the first attempt. */
function failFast(capture: Ref<StreamDlqCaptureResult>) {
  return {
    startingPosition: StartingPosition.TRIM_HORIZON,
    // One attempt, so the failure reaches capture without waiting out retries.
    retryAttempts: 0,
    onFailure: s3OnFailure(capture),
  };
}

/** A processor that fails every batch from `source`. */
function failingProcessor(key: string, source: ComposureEventSource): IFunctionBuilder {
  return createFunctionBuilder()
    .runtime(Runtime.NODEJS_22_X)
    .handler("index.handler")
    .code(
      Code.fromInline(
        'exports.handler = async () => { throw new Error("deploy test: fail every batch"); };',
      ),
    )
    .addEventSource(key, source);
}

/**
 * A processor that fails every batch, reading a table's stream, with capture
 * as its on-failure destination: the README's getting-started example, built
 * from the published package.
 *
 * A second processor fails the same record into a capture encrypted with a
 * customer-managed key, and a third fails a record from a Kinesis stream into
 * its own capture (see functional/README.md).
 */
export function deployTestStack(app: App): Stack {
  const stack = new Stack(app, STACK_NAME);

  const keyRef = ref<KeyBuilderResult>("key").get("key");
  const table = ref<TableV2BuilderResult>("orders").get("table");
  const {
    orders,
    failures,
    processor,
    keyedFailures,
    keyedProcessor,
    events,
    kinesisFailures,
    kinesisProcessor,
  } = compose(
    {
      orders: createTableV2Builder()
        .partitionKey({ name: "pk", type: AttributeType.STRING })
        .dynamoStream(StreamViewType.NEW_AND_OLD_IMAGES),

      failures: createStreamDlqCaptureBuilder(),
      processor: failingProcessor("orders", dynamoEventSource(table, failFast(ref("failures")))),

      key: createKeyBuilder(),
      keyedFailures: createStreamDlqCaptureBuilder()
        .bucket((b) => b.encryption(BucketEncryption.KMS).encryptionKey(keyRef))
        .queue((q) => q.encryption(QueueEncryption.KMS).encryptionMasterKey(keyRef)),
      keyedProcessor: failingProcessor(
        "orders",
        dynamoEventSource(table, failFast(ref("keyedFailures"))),
      ),

      events: createStreamBuilder().streamName(EVENTS_STREAM_NAME),
      kinesisFailures: createStreamDlqCaptureBuilder(),
      kinesisProcessor: failingProcessor(
        "events",
        kinesisEventSource(
          ref<StreamBuilderResult>("events").get("stream"),
          failFast(ref("kinesisFailures")),
        ),
      ),
    },
    {
      orders: [],
      failures: [],
      processor: ["orders", "failures"],
      key: [],
      keyedFailures: ["key"],
      keyedProcessor: ["orders", "keyedFailures"],
      events: [],
      kinesisFailures: [],
      kinesisProcessor: ["events", "kinesisFailures"],
    },
  ).build(stack, "App");

  const outputs: Outputs = {
    TableName: orders.table.tableName,
    FunctionName: processor.function.functionName,
    BucketName: failures.bucket.bucket.bucketName,
    QueueUrl: failures.queue.queue.queueUrl,
    AlarmName: failures.alarms.failuresWaiting.alarmName,
    KeyedFunctionName: keyedProcessor.function.functionName,
    KeyedBucketName: keyedFailures.bucket.bucket.bucketName,
    KeyedQueueUrl: keyedFailures.queue.queue.queueUrl,
    StreamName: events.stream.streamName,
    KinesisFunctionName: kinesisProcessor.function.functionName,
    KinesisBucketName: kinesisFailures.bucket.bucket.bucketName,
    KinesisQueueUrl: kinesisFailures.queue.queue.queueUrl,
  };
  for (const [key, value] of Object.entries(outputs)) new CfnOutput(stack, key, { value });

  return stack;
}
