// Drives the deployed deploy-test stack through one failure, end to end:
// write a record, the processor fails it, the batch lands in the failure
// bucket, the signal reaches the queue, and the depth alarm fires; then drain
// the queue and wait for the alarm to clear. Exits non-zero on the first step
// that times out. See functional/README.md.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { setTimeout as delay } from "node:timers/promises";
import { OUTPUTS, type Outputs, STACK_NAME } from "./stack.ts";

const MINUTE = 60_000;

/**
 * Polls `check` every 15 s until it returns a value, or throws after
 * `timeoutMs`. `undefined` and `false` both mean "not yet".
 */
async function waitFor<T>(
  step: string,
  timeoutMs: number,
  check: () => Promise<T | undefined | false>,
): Promise<T> {
  const started = Date.now();
  console.log(`… ${step}`);
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) {
      console.log(`✓ ${step} (${String(Math.round((Date.now() - started) / 1000))} s)`);
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${String(timeoutMs / MINUTE)} min: ${step}`);
    }
    await delay(15_000);
  }
}

async function readOutputs(): Promise<Outputs> {
  const { Stacks } = await new CloudFormationClient().send(
    new DescribeStacksCommand({ StackName: STACK_NAME }),
  );
  const values = new Map(Stacks?.[0]?.Outputs?.map((o) => [o.OutputKey, o.OutputValue]));
  return Object.fromEntries(
    OUTPUTS.map((key) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`${STACK_NAME} has no ${key} output`);
      return [key, value];
    }),
  ) as Outputs;
}

const outputs = await readOutputs();
const cloudwatch = new CloudWatchClient();
const lambda = new LambdaClient();
const s3 = new S3Client();
const sqs = new SQSClient();

function waitForAlarm(state: "ALARM" | "OK", timeoutMs: number): Promise<true> {
  return waitFor(`failuresWaiting alarm in ${state}`, timeoutMs, async () => {
    const { MetricAlarms } = await cloudwatch.send(
      new DescribeAlarmsCommand({ AlarmNames: [outputs.AlarmName] }),
    );
    return MetricAlarms?.[0]?.StateValue === state;
  });
}

/** The first object in `bucket` written at or after `since`. */
function waitForFailureObject(label: string, bucket: string, since: number): Promise<string> {
  return waitFor(`failed batch written to the ${label}failure bucket`, 10 * MINUTE, async () => {
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    return Contents?.find((object) => (object.LastModified?.getTime() ?? 0) >= since)?.Key;
  });
}

// The signal is the bucket's Object Created event, so it names the object.
// Deleting it is what an operator does once the failure is dealt with.
function receiveAndDeleteSignal(label: string, queueUrl: string, key: string): Promise<true> {
  return waitFor(`${label}signal for that object received and deleted`, 5 * MINUTE, async () => {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }),
    );
    const signal = Messages?.find((message) => message.Body?.includes(JSON.stringify(key)));
    if (!signal) return undefined;
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: signal.ReceiptHandle }),
    );
    return true;
  });
}

// A new mapping takes minutes to start reading. TRIM_HORIZON means a record
// written before then is still read, but waiting keeps the timings honest.
await Promise.all(
  [outputs.FunctionName, outputs.KeyedFunctionName].map((functionName) =>
    waitFor(`event source mapping for ${functionName} enabled`, 10 * MINUTE, async () => {
      const { EventSourceMappings } = await lambda.send(
        new ListEventSourceMappingsCommand({ FunctionName: functionName }),
      );
      return EventSourceMappings?.[0]?.State === "Enabled";
    }),
  ),
);

const pk = `deploy-test-${new Date().toISOString()}`;
await new DynamoDBClient().send(
  new PutItemCommand({ TableName: outputs.TableName, Item: { pk: { S: pk } } }),
);
// Only objects written after this count, so a rerun against a stack that
// wasn't destroyed can't pass on an earlier run's failure. Allows 2 s of skew.
const written = Date.now() - 2_000;
console.log(`✓ wrote ${pk}`);

// The keyed capture runs alongside the main flow, so a failure there surfaces
// without waiting the main flow out.
const keyed = waitForFailureObject("keyed ", outputs.KeyedBucketName, written).then((key) =>
  receiveAndDeleteSignal("keyed ", outputs.KeyedQueueUrl, key),
);

async function main(): Promise<void> {
  const key = await waitForFailureObject("", outputs.BucketName, written);
  console.log(`  ${key}`);
  await waitForAlarm("ALARM", 10 * MINUTE);
  // Deleting the signal lets the alarm clear.
  await receiveAndDeleteSignal("", outputs.QueueUrl, key);
  await waitForAlarm("OK", 15 * MINUTE);
}

await Promise.all([main(), keyed]);

console.log("Deploy test passed.");
