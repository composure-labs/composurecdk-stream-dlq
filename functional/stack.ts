import { type App, CfnOutput, Stack } from "aws-cdk-lib";
import { AttributeType, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Code, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { BucketEncryption } from "aws-cdk-lib/aws-s3";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { compose, type Ref, ref } from "@composurecdk/core";
import { createTableV2Builder, type TableV2BuilderResult } from "@composurecdk/dynamodb";
import { createKeyBuilder, type KeyBuilderResult } from "@composurecdk/kms";
import {
  createFunctionBuilder,
  dynamoEventSource,
  type IFunctionBuilder,
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
] as const;
export type Outputs = Record<(typeof OUTPUTS)[number], string>;

/** A processor that fails every batch from the orders stream, sending each to `capture`. */
function failingProcessor(capture: Ref<StreamDlqCaptureResult>): IFunctionBuilder {
  return createFunctionBuilder()
    .runtime(Runtime.NODEJS_22_X)
    .handler("index.handler")
    .code(
      Code.fromInline(
        'exports.handler = async () => { throw new Error("deploy test: fail every batch"); };',
      ),
    )
    .addEventSource(
      "orders",
      dynamoEventSource(ref<TableV2BuilderResult>("orders").get("table"), {
        startingPosition: StartingPosition.TRIM_HORIZON,
        // One attempt, so the failure reaches capture without waiting out retries.
        retryAttempts: 0,
        onFailure: s3OnFailure(capture),
      }),
    );
}

/**
 * A processor that fails every batch, reading a table's stream, with capture
 * as its on-failure destination: the README's getting-started example, built
 * from the published package.
 *
 * A second processor fails the same record into a capture encrypted with a
 * customer-managed key (see functional/README.md).
 */
export function deployTestStack(app: App): Stack {
  const stack = new Stack(app, STACK_NAME);

  const keyRef = ref<KeyBuilderResult>("key").get("key");
  const { orders, failures, processor, keyedFailures, keyedProcessor } = compose(
    {
      orders: createTableV2Builder()
        .partitionKey({ name: "pk", type: AttributeType.STRING })
        .dynamoStream(StreamViewType.NEW_AND_OLD_IMAGES),

      failures: createStreamDlqCaptureBuilder(),
      processor: failingProcessor(ref("failures")),

      key: createKeyBuilder(),
      keyedFailures: createStreamDlqCaptureBuilder()
        .bucket((b) => b.encryption(BucketEncryption.KMS).encryptionKey(keyRef))
        .queue((q) => q.encryption(QueueEncryption.KMS).encryptionMasterKey(keyRef)),
      keyedProcessor: failingProcessor(ref("keyedFailures")),
    },
    {
      orders: [],
      failures: [],
      processor: ["orders", "failures"],
      key: [],
      keyedFailures: ["key"],
      keyedProcessor: ["orders", "keyedFailures"],
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
  };
  for (const [key, value] of Object.entries(outputs)) new CfnOutput(stack, key, { value });

  return stack;
}
