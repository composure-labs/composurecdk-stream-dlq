import { App, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { AttributeType, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Rule } from "aws-cdk-lib/aws-events";
import { SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Key } from "aws-cdk-lib/aws-kms";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { S3OnFailureDestination } from "aws-cdk-lib/aws-lambda-event-sources";
import { type Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { SqsDestination } from "aws-cdk-lib/aws-s3-notifications";
import { type Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { compose, ref } from "@composurecdk/core";
import { createTableV2Builder, type TableV2BuilderResult } from "@composurecdk/dynamodb";
import { createKeyBuilder } from "@composurecdk/kms";
import { createFunctionBuilder, dynamoEventSource } from "@composurecdk/lambda";
import { type BucketBuilderResult, createBucketBuilder } from "@composurecdk/s3";
import { createQueueBuilder } from "@composurecdk/sqs";
import { PROCESSOR_HANDLER, REPLAY_HANDLER } from "./handlers.js";

/** Every stack is `ComposureLabs-StreamDlq-*`, the OIDC role's scope. */
const PREFIX = "ComposureLabs-StreamDlq-";
const PROCESSOR_TIMEOUT = Duration.minutes(3);

/** Plan §2's failure-role lifecycle: about 97 days' effective retention. */
function failureBucket() {
  return createBucketBuilder().lifecycleRules([
    { abortIncompleteMultipartUploadAfter: Duration.days(7) },
    { expiration: Duration.days(90), noncurrentVersionExpiration: Duration.days(7) },
  ]);
}

/** Plan §3: the capture side keeps a 1-minute visibility; drain() heartbeats. */
function signalQueue() {
  return createQueueBuilder("dlq").visibilityTimeout(Duration.minutes(1));
}

function newStack(app: App, name: string): Stack {
  const stack = new Stack(app, `${PREFIX}${name}`);
  Tags.of(stack).add("composure-labs:spike", "623");
  return stack;
}

function outputs(stack: Stack, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    new CfnOutput(stack, `Out${key}`, { value, key });
  }
}

function alarmOutputs(stack: Stack, alarms: Record<string, { alarmName: string }>): void {
  outputs(
    stack,
    Object.fromEntries(Object.entries(alarms).map(([k, a]) => [`SignalAlarm${k}`, a.alarmName])),
  );
}

type SignalQueueBuilder = ReturnType<typeof signalQueue>;

/**
 * Table → processor (MODE-switchable) → S3 on-failure destination, with the
 * signal path chosen by `signal`. Scenarios 1, 2, 4, 5 and 6.
 */
export function captureStack(
  app: App,
  name: string,
  options: { signal: "direct" | "eventbridge"; replay: boolean; notifyPrefix?: string },
): Stack {
  const stack = newStack(app, name);
  const bucket = failureBucket();
  if (options.signal === "eventbridge") {
    bucket.eventBridgeEnabled(true);
  }

  const results = compose(
    {
      table: createTableV2Builder()
        .partitionKey({ name: "pk", type: AttributeType.STRING })
        .dynamoStream(StreamViewType.NEW_AND_OLD_IMAGES)
        .deletionProtection(false)
        .removalPolicy(RemovalPolicy.DESTROY),
      failures: bucket,
      signal: signalQueue(),
      processor: createFunctionBuilder()
        .runtime(Runtime.NODEJS_22_X)
        .handler("index.handler")
        .code(Code.fromInline(PROCESSOR_HANDLER))
        .timeout(PROCESSOR_TIMEOUT)
        .environment({ MODE: "throw" })
        .addEventSource(
          "table",
          dynamoEventSource(
            ref("table", (r: TableV2BuilderResult) => r.table),
            {
              // One PutItem → one failure object, in seconds.
              retryAttempts: 0,
              bisectBatchOnError: false,
              onFailure: ref(
                "failures",
                (r: BucketBuilderResult) => new S3OnFailureDestination(r.bucket),
              ),
            },
          ),
        ),
    },
    { table: [], failures: [], signal: [], processor: ["table", "failures"] },
  ).build(stack, "Capture");

  const failureBucketConstruct: Bucket = results.failures.bucket;
  const queue: Queue = results.signal.queue;

  if (options.signal === "direct") {
    failureBucketConstruct.addEventNotification(
      EventType.OBJECT_CREATED,
      new SqsDestination(queue),
      ...(options.notifyPrefix ? [{ prefix: options.notifyPrefix }] : []),
    );
  } else {
    new Rule(stack, "FailureObjectCreated", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: { bucket: { name: [failureBucketConstruct.bucketName] } },
      },
      targets: [new SqsQueue(queue)],
    });
  }

  const fn = results.processor.function;
  outputs(stack, {
    TableName: results.table.table.tableName,
    ProcessorName: fn.functionName,
    ProcessorLogGroup: results.processor.logGroup?.logGroupName ?? `/aws/lambda/${fn.functionName}`,
    BucketName: failureBucketConstruct.bucketName,
    QueueUrl: queue.queueUrl,
  });
  alarmOutputs(stack, results.signal.alarms);

  if (options.replay) {
    const replay = createFunctionBuilder()
      .runtime(Runtime.NODEJS_22_X)
      .handler("index.handler")
      .code(Code.fromInline(REPLAY_HANDLER))
      .timeout(Duration.minutes(10))
      // B2: one drain at a time.
      .reservedConcurrentExecutions(1)
      .environment({
        BUCKET: failureBucketConstruct.bucketName,
        QUEUE_URL: queue.queueUrl,
        TARGET: fn.functionName,
        TARGET_TIMEOUT_SECONDS: String(PROCESSOR_TIMEOUT.toSeconds()),
      })
      .build(stack, "Replay");
    failureBucketConstruct.grantRead(replay.function);
    failureBucketConstruct.grantDelete(replay.function);
    queue.grantConsumeMessages(replay.function);
    fn.grantInvoke(replay.function);
    outputs(stack, {
      ReplayName: replay.function.functionName,
      ReplayLogGroup:
        replay.logGroup?.logGroupName ?? `/aws/lambda/${replay.function.functionName}`,
    });
  }
  return stack;
}

/**
 * Bucket → queue, with no stream: the runner writes objects itself.
 * Scenario 3 (queue encryption) and scenario 5's age alarm (short retention).
 */
export function signalOnlyStack(
  app: App,
  name: string,
  configure: (queue: SignalQueueBuilder, stack: Stack) => void,
): Stack {
  const stack = newStack(app, name);
  const queueBuilder = signalQueue();
  configure(queueBuilder, stack);
  const results = compose(
    { failures: failureBucket(), signal: queueBuilder },
    { failures: [], signal: [] },
  ).build(stack, "Capture");
  results.failures.bucket.addEventNotification(
    EventType.OBJECT_CREATED,
    new SqsDestination(results.signal.queue),
  );
  outputs(stack, {
    BucketName: results.failures.bucket.bucketName,
    QueueUrl: results.signal.queue.queueUrl,
  });
  alarmOutputs(stack, results.signal.alarms);
  return stack;
}

/** A CMK that `cdk destroy` schedules for deletion after the minimum window. */
export function spikeKey(stack: Stack): Key {
  return createKeyBuilder()
    .removalPolicy(RemovalPolicy.DESTROY)
    .pendingWindow(Duration.days(7))
    .build(stack, "QueueKey").key;
}

export { QueueEncryption };
