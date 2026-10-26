/**
 * Drives the spike's scenarios against the deployed stacks and writes what it
 * observes to results/<scenario>.json. Usage: node dist/src/run.js <scenario>
 */
import { writeFileSync } from "node:fs";
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { BatchWriteItemCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  GetEventSourceMappingCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const cfn = new CloudFormationClient({});
const cw = new CloudWatchClient({});
const logs = new CloudWatchLogsClient({});
const ddb = new DynamoDBClient({});
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const sqs = new SQSClient({});

const PREFIX = "ComposureLabs-StreamDlq-";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

function save(name: string, data: unknown): void {
  writeFileSync(
    new URL(`../../results/${name}.json`, import.meta.url),
    JSON.stringify(data, null, 2) + "\n",
  );
  log(`wrote results/${name}.json`);
}

async function outputs(stack: string): Promise<Record<string, string>> {
  const out = await cfn.send(new DescribeStacksCommand({ StackName: PREFIX + stack }));
  return Object.fromEntries(
    (out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutS: number,
  everyS = 5,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await sleep(everyS * 1000);
  }
  log(`timed out after ${String(timeoutS)}s waiting for ${what}`);
  return undefined;
}

/** Receives without hiding anything (visibility 0), deduplicated by message id. */
async function peek(queueUrl: string, rounds = 3) {
  const seen = new Map<string, { body: unknown; sentAt: number; receiveCount: number }>();
  for (let i = 0; i < rounds; i++) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 0,
        MessageSystemAttributeNames: ["SentTimestamp", "ApproximateReceiveCount"],
      }),
    );
    for (const m of out.Messages ?? []) {
      seen.set(m.MessageId ?? "", {
        body: JSON.parse(m.Body ?? "null"),
        sentAt: Number(m.Attributes?.SentTimestamp),
        receiveCount: Number(m.Attributes?.ApproximateReceiveCount),
      });
    }
  }
  return [...seen.values()];
}

async function queueDepth(queueUrl: string) {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(out.Attributes?.ApproximateNumberOfMessages),
    inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible),
  };
}

/** The UUID of the function's (only) event source mapping. */
async function mappingUuid(fn: string): Promise<string> {
  const out = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fn }));
  return out.EventSourceMappings?.[0]?.UUID ?? "";
}

async function setMode(fn: string, mode: string): Promise<void> {
  await lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: fn,
      Environment: { Variables: { MODE: mode } },
    }),
  );
  await waitFor(
    `${fn} MODE=${mode}`,
    async () => {
      const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
      return c.LastUpdateStatus === "Successful" ? true : undefined;
    },
    120,
    2,
  );
  log(`MODE=${mode}`);
}

const item = (pk: string) => ({ pk: { S: pk }, at: { S: new Date().toISOString() } });

async function putItem(table: string, pk: string): Promise<number> {
  await ddb.send(new PutItemCommand({ TableName: table, Item: item(pk) }));
  log(`PutItem pk=${pk}`);
  return Date.now();
}

/** Failure objects written after `since`, allowing 2s of clock skew. */
async function objectsSince(bucket: string, since: number) {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (out.Contents ?? [])
    .filter((o) => o.Key !== undefined && (o.LastModified?.getTime() ?? 0) >= since - 2000)
    .map((o) => ({ key: o.Key ?? "", lastModified: o.LastModified?.getTime() ?? 0 }));
}

/** The first failure object written after `since`. */
async function waitForObject(bucket: string, since: number, timeoutS = 180) {
  return waitFor("failure object", async () => (await objectsSince(bucket, since))[0], timeoutS);
}

async function getObject(bucket: string, key: string): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await out.Body?.transformToString()) ?? "";
}

async function logEvents(group: string, pattern: string, since: number) {
  const events: { timestamp: number; message: string }[] = [];
  let nextToken: string | undefined;
  do {
    const out = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: group,
        filterPattern: pattern,
        startTime: since,
        nextToken,
      }),
    );
    for (const e of out.events ?? [])
      events.push({ timestamp: e.timestamp ?? 0, message: e.message ?? "" });
    nextToken = out.nextToken;
  } while (nextToken);
  return events;
}

/** The processor's SPIKE_INVOKE lines that mention `pk`. */
async function invocationsFor(group: string, pk: string, since: number) {
  const events = await logEvents(group, `"SPIKE_INVOKE" "${pk}"`, since);
  // The function builder sets JSON log format: the line is an envelope whose
  // `message` is the string the processor logged.
  return events.map((e) => {
    const envelope = JSON.parse(e.message) as { message: string };
    return {
      timestamp: e.timestamp,
      ...(JSON.parse(envelope.message) as { mode: string; pks: string[]; event: unknown }),
    };
  });
}

async function alarmStates(names: string[]) {
  const out = await cw.send(new DescribeAlarmsCommand({ AlarmNames: names }));
  return Object.fromEntries((out.MetricAlarms ?? []).map((a) => [a.AlarmName, a.StateValue]));
}

async function alarmHistory(name: string, since: number) {
  const out = await cw.send(
    new DescribeAlarmHistoryCommand({
      AlarmName: name,
      HistoryItemType: "StateUpdate",
      StartDate: new Date(since),
    }),
  );
  return (out.AlarmHistoryItems ?? []).map((h) => ({
    at: h.Timestamp?.toISOString(),
    summary: h.HistorySummary,
  }));
}

/** Each metric's 1-minute sums since `since`, as `{ minute: sum }`. */
async function metricSums(
  namespace: string,
  dimensions: Record<string, string>,
  names: string[],
  since: number,
) {
  const out = await cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(since - 60_000),
      EndTime: new Date(),
      MetricDataQueries: names.map((name, i) => ({
        Id: `m${String(i)}`,
        Label: name,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: name,
            Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
          },
          Period: 60,
          Stat: "Sum",
        },
      })),
    }),
  );
  return Object.fromEntries(
    (out.MetricDataResults ?? []).map((r) => [
      r.Label ?? "",
      Object.fromEntries(
        (r.Timestamps ?? []).map((t, i) => [t.toISOString().slice(11, 16), r.Values?.[i]]),
      ),
    ]),
  );
}

/** EventBridge's per-rule delivery metrics. */
const RULE_METRICS = [
  "MatchedEvents",
  "Invocations",
  "FailedInvocations",
  "RetryInvocationAttempts",
];

async function invokeReplay(name: string) {
  const started = Date.now();
  const out = await lambda.send(
    new InvokeCommand({ FunctionName: name, InvocationType: "RequestResponse" }),
  );
  const payload = out.Payload ? Buffer.from(out.Payload).toString("utf8") : "";
  return {
    functionError: out.FunctionError,
    summary: JSON.parse(payload) as unknown,
    seconds: (Date.now() - started) / 1000,
  };
}

const scenarios: Record<string, () => Promise<void>> = {
  /** 1: what the queue holds after a deploy, and whether the depth alarm trips. */
  async s1() {
    const o = await outputs(process.argv[3] ?? "Direct");
    const since = Number(process.argv[4] ?? Date.now() - 3600_000);
    const messages = await peek(o.QueueUrl);
    log(`${String(messages.length)} message(s) on the queue`);
    const visibleAlarm = o.SignalAlarmapproximateNumberOfMessagesVisible;
    const state = await waitFor(
      "depth alarm ALARM",
      async () =>
        (await alarmStates([visibleAlarm]))[visibleAlarm] === "ALARM" ? "ALARM" : undefined,
      messages.length > 0 ? 600 : 1,
      20,
    );
    save(`s1-${process.argv[3] ?? "Direct"}-${String(Date.now())}`, {
      messages,
      depthAlarmReachedAlarm: state === "ALARM",
      history: await alarmHistory(visibleAlarm, since),
    });
  },

  /** 2 and 4: one failure through each signal path; object shape, payload re-invoke, latency. */
  async s4() {
    const stack = process.argv[3] ?? "Direct";
    const o = await outputs(stack);
    await setMode(o.ProcessorName, "throw");
    const pk = `s4-${stack}-${String(Date.now())}`;
    const putAt = await putItem(o.TableName, pk);
    const object = await waitForObject(o.BucketName, putAt);
    if (!object) throw new Error("no failure object");
    log(`failure object ${object.key} after ${String((object.lastModified - putAt) / 1000)}s`);
    const raw = await getObject(o.BucketName, object.key);
    const record = JSON.parse(raw) as Record<string, unknown>;

    const message = await waitFor(
      "signal message",
      async () =>
        (await peek(o.QueueUrl, 1)).find((m) =>
          JSON.stringify(m.body).includes(object.key.slice(-20)),
        ),
      120,
      2,
    );

    // The event the ESM delivered, from the processor's own log line.
    const original = await waitFor(
      "processor log",
      async () => {
        const invocations = await invocationsFor(o.ProcessorLogGroup, pk, putAt - 5000);
        return invocations[0];
      },
      120,
    );

    // Re-invoke with the payload exactly as stored.
    await setMode(o.ProcessorName, "succeed");
    const payload =
      typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload);
    const reinvokeAt = Date.now();
    const out = await lambda.send(
      new InvokeCommand({ FunctionName: o.ProcessorName, Payload: payload }),
    );
    const replayed = await waitFor(
      "re-invoke log",
      async () =>
        (await invocationsFor(o.ProcessorLogGroup, pk, reinvokeAt - 1000)).find(
          (i) => i.mode === "succeed",
        ),
      120,
    );
    await setMode(o.ProcessorName, "throw");

    save(`s4-${stack}`, {
      objectKey: object.key,
      objectBytes: raw.length,
      topLevelKeys: Object.keys(record),
      payloadType: typeof record.payload,
      recordWithoutPayload: {
        ...record,
        payload: `<${typeof record.payload}, ${String(payload.length)} chars>`,
      },
      secondsPutToObject: (object.lastModified - putAt) / 1000,
      secondsObjectToMessage: message ? (message.sentAt - object.lastModified) / 1000 : null,
      message: message?.body,
      reinvoke: { statusCode: out.StatusCode, functionError: out.FunctionError },
      payloadMatchesOriginalEvent:
        original !== undefined &&
        JSON.stringify(replayed?.event) === JSON.stringify(original.event),
      originalEvent: original?.event,
      replayedEvent: replayed?.event,
    });
  },

  /** 3: does a message arrive on a queue whose stack deployed? */
  async s3() {
    const stack = process.argv[3] ?? "EncCmk";
    const o = await outputs(stack);
    const key = `aws/lambda/spike/${String(Date.now())}`;
    const putAt = Date.now();
    await s3.send(new PutObjectCommand({ Bucket: o.BucketName, Key: key, Body: "{}" }));
    const message = await waitFor(
      "message",
      async () => (await peek(o.QueueUrl, 1)).find((m) => JSON.stringify(m.body).includes(key)),
      90,
      3,
    );
    save(`s3-${stack}`, {
      delivered: message !== undefined,
      seconds: message ? (message.sentAt - putAt) / 1000 : null,
      allMessages: await peek(o.QueueUrl),
    });
  },

  /** 5: the full loop through the prototype drain(), B1 and B2. */
  async s5() {
    const o = await outputs("Direct");
    const runStart = Date.now();
    const results: Record<string, unknown> = {};

    // Clear what earlier scenarios left, so each case starts from an empty queue.
    await setMode(o.ProcessorName, "succeed");
    results.backlog = await invokeReplay(o.ReplayName);
    results.depthAfterBacklog = await queueDepth(o.QueueUrl);

    async function failOne(label: string) {
      await setMode(o.ProcessorName, "throw");
      const pk = `s5-${label}-${String(Date.now())}`;
      const putAt = await putItem(o.TableName, pk);
      const object = await waitForObject(o.BucketName, putAt);
      await waitFor(
        "message visible",
        async () => ((await queueDepth(o.QueueUrl)).visible > 0 ? true : undefined),
        120,
        2,
      );
      return { pk, key: object?.key ?? "", putAt };
    }
    async function objectExists(key: string) {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: o.BucketName, Prefix: key }));
      return (out.Contents ?? []).some((c) => c.Key === key);
    }

    for (const mode of ["succeed", "partial", "throw"]) {
      const failed = await failOne(mode);
      await setMode(o.ProcessorName, mode);
      const replayAt = Date.now();
      const drained = await invokeReplay(o.ReplayName);
      await sleep(5000);
      results[mode] = {
        drained,
        objectStillExists: await objectExists(failed.key),
        depth: await queueDepth(o.QueueUrl),
        replayInvocations: (await invocationsFor(o.ProcessorLogGroup, failed.pk, replayAt)).length,
      };
      log(mode, JSON.stringify(results[mode]));
    }

    // Recovery after a fix: the kept messages were released, so a re-run sees them now.
    await setMode(o.ProcessorName, "succeed");
    results.afterFix = {
      drained: await invokeReplay(o.ReplayName),
      depth: await queueDepth(o.QueueUrl),
    };
    log("afterFix", JSON.stringify(results.afterFix));

    // B2: the processor outlives the queue's 60s visibility timeout.
    const slow = await failOne("sleep");
    await setMode(o.ProcessorName, "sleep:90");
    const slowAt = Date.now();
    await lambda.send(new InvokeCommand({ FunctionName: o.ReplayName, InvocationType: "Event" }));
    const depthSamples: unknown[] = [];
    for (const at of [30, 75, 100]) {
      await sleep(at * 1000 - (Date.now() - slowAt));
      depthSamples.push({ secondsIn: at, ...(await queueDepth(o.QueueUrl)) });
    }
    // A second drain while the first is running: reserved concurrency 1.
    let concurrentDrain: unknown;
    try {
      concurrentDrain = await invokeReplay(o.ReplayName);
    } catch (error) {
      concurrentDrain = { error: (error as Error).name };
    }
    const done = await waitFor(
      "slow drain to finish",
      async () =>
        (await logEvents(o.ReplayLogGroup, '"SPIKE_DRAIN"', slowAt)).find((e) =>
          e.message.includes(slow.key),
        ),
      300,
      10,
    );
    results.sleepLongerThanVisibility = {
      depthSamples,
      concurrentDrain,
      drainLog: done?.message,
      replayInvocations: (await invocationsFor(o.ProcessorLogGroup, slow.pk, slowAt)).length,
      objectStillExists: await objectExists(slow.key),
      depth: await queueDepth(o.QueueUrl),
    };
    log("sleep", JSON.stringify(results.sleepLongerThanVisibility));

    await setMode(o.ProcessorName, "throw");
    results.depthAlarmHistory = await alarmHistory(
      o.SignalAlarmapproximateNumberOfMessagesVisible,
      runStart,
    );
    save("s5", results);
  },

  /** 5's B2 guard: a second drain while one is running, against reserved concurrency 1. */
  async concurrency() {
    const o = await outputs("Direct");
    await setMode(o.ProcessorName, "throw");
    const pk = `s5-concurrency-${String(Date.now())}`;
    const putAt = await putItem(o.TableName, pk);
    await waitForObject(o.BucketName, putAt);
    await sleep(5000);
    await setMode(o.ProcessorName, "sleep:60");
    const startedAt = Date.now();
    await lambda.send(new InvokeCommand({ FunctionName: o.ReplayName, InvocationType: "Event" }));
    await sleep(20_000);
    let second: unknown;
    try {
      second = await invokeReplay(o.ReplayName);
    } catch (error) {
      second = { error: (error as Error).name, message: (error as Error).message };
    }
    log("second drain", JSON.stringify(second));
    const first = await waitFor(
      "first drain",
      async () =>
        (await logEvents(o.ReplayLogGroup, '"SPIKE_DRAIN"', startedAt)).find(
          (e) => e.message.includes(pk) || e.message.includes("replayed"),
        ),
      180,
      10,
    );
    await sleep(60_000);
    const settled = await queueDepth(o.QueueUrl);
    await setMode(o.ProcessorName, "throw");
    save("s5-concurrency", {
      secondDrainAt20s: second,
      firstDrainLog: first?.message,
      replayInvocations: (await invocationsFor(o.ProcessorLogGroup, pk, startedAt)).length,
      depthAfter60sSettle: settled,
      depthAlarmState: await alarmStates([o.SignalAlarmapproximateNumberOfMessagesVisible]),
    });
  },

  /** 5's age alarm: one object, left alone, on a 5-minute-retention queue. */
  async age() {
    const o = await outputs("ShortRetention");
    const putAt = Date.now();
    const key = `aws/lambda/spike/age-${String(putAt)}`;
    await s3.send(new PutObjectCommand({ Bucket: o.BucketName, Key: key, Body: "{}" }));
    log("object written; sampling for 9 minutes");
    const samples: unknown[] = [];
    for (let minute = 1; minute <= 9; minute++) {
      await sleep(minute * 60_000 - (Date.now() - putAt));
      samples.push({
        minute,
        depth: await queueDepth(o.QueueUrl),
        alarms: await alarmStates([
          o.SignalAlarmapproximateAgeOfOldestMessage,
          o.SignalAlarmapproximateNumberOfMessagesVisible,
        ]),
      });
      log(JSON.stringify(samples.at(-1)));
    }
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: o.BucketName, Prefix: key }));
    save("s5-age", {
      samples,
      objectStillInBucket: (objects.Contents ?? []).length > 0,
      ageAlarmHistory: await alarmHistory(o.SignalAlarmapproximateAgeOfOldestMessage, putAt),
      depthAlarmHistory: await alarmHistory(o.SignalAlarmapproximateNumberOfMessagesVisible, putAt),
    });
  },

  /**
   * F14: does EventBridge deliver to a CMK-encrypted queue, and does a key
   * policy without its statement surface as the rule's FailedInvocations?
   * Run once per stack: CmkCdk, CmkScoped, CmkNoPolicy.
   */
  async f14() {
    const stack = process.argv[3] ?? "CmkScoped";
    const o = await outputs(stack);
    const key = `aws/lambda/spike/f14-${String(Date.now())}`;
    const putAt = Date.now();
    await s3.send(new PutObjectCommand({ Bucket: o.BucketName, Key: key, Body: "{}" }));
    const message = await waitFor(
      "message",
      async () => (await peek(o.QueueUrl, 1)).find((m) => JSON.stringify(m.body).includes(key)),
      180,
      5,
    );
    // Rule metrics publish a few minutes late; FailedInvocations is the drift signal.
    const failedAlarm = await waitFor(
      "rule FailedInvocations alarm",
      async () =>
        (await alarmStates([o.RuleFailedAlarm]))[o.RuleFailedAlarm] === "ALARM" ? true : undefined,
      message ? 1 : 600,
      20,
    );
    save(`f14-${stack}`, {
      delivered: message !== undefined,
      seconds: message ? (message.sentAt - putAt) / 1000 : null,
      ruleFailedAlarmReachedAlarm: failedAlarm === true,
      ruleMetrics: await metricSums("AWS/Events", { RuleName: o.RuleName }, RULE_METRICS, putAt),
      ruleFailedAlarmHistory: await alarmHistory(o.RuleFailedAlarm, putAt),
    });
  },

  /**
   * F1: the mapping can't write its failure object (the bucket policy denies
   * the processor's role). Does anything raise it: the mapping's
   * DroppedEventCount, composureCDK's processor alarms, the mapping's state?
   */
  async f1() {
    const o = await outputs("DestinationDenied");
    await setMode(o.ProcessorName, "throw");
    const pk = `f1-${String(Date.now())}`;
    const putAt = await putItem(o.TableName, pk);
    const object = await waitForObject(o.BucketName, putAt, 240);
    log(object ? `unexpected failure object ${object.key}` : "no failure object, as expected");

    const uuid = await mappingUuid(o.ProcessorName);
    const processorAlarms = Object.entries(o)
      .filter(([key]) => key.startsWith("ProcessorAlarm"))
      .map(([, name]) => name);
    // ESM metrics publish late: sample for 10 minutes.
    const samples: unknown[] = [];
    const sampleFrom = Date.now();
    for (let minute = 1; minute <= 10; minute++) {
      await sleep(minute * 60_000 - (Date.now() - sampleFrom));
      samples.push({ minute, alarms: await alarmStates(processorAlarms) });
      log(JSON.stringify(samples.at(-1)));
    }
    const mapping = await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }));
    save("f1", {
      failureObjectWritten: object !== undefined,
      invocations: (await invocationsFor(o.ProcessorLogGroup, pk, putAt - 5000)).length,
      mapping: {
        state: mapping.State,
        lastProcessingResult: mapping.LastProcessingResult,
        destinationConfig: mapping.DestinationConfig,
      },
      esmMetrics: await metricSums(
        "AWS/Lambda",
        { EventSourceMappingUUID: uuid },
        [
          "PolledEventCount",
          "FailedInvokeEventCount",
          "DroppedEventCount",
          "OnFailureDestinationDeliveredEventCount",
        ],
        putAt,
      ),
      functionMetrics: await metricSums(
        "AWS/Lambda",
        { FunctionName: o.ProcessorName },
        ["Errors", "DestinationDeliveryFailures"],
        putAt,
      ),
      alarmSamples: samples,
      alarmHistory: Object.fromEntries(
        await Promise.all(processorAlarms.map(async (a) => [a, await alarmHistory(a, putAt)])),
      ),
    });
  },

  /**
   * F5's recovery window: deny EventBridge on the queue, write an object,
   * restore the policy after `holdMinutes` (default 5), then see whether the
   * default retry policy delivers the signal late. The policy is restored
   * even if the run fails.
   */
  async f5() {
    const o = await outputs("SignalRetry");
    const holdMinutes = Number(process.argv[3] ?? 5);
    const original = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: o.QueueUrl,
        AttributeNames: ["Policy", "QueueArn"],
      }),
    );
    const policy = original.Attributes?.Policy ?? "";
    const denied = JSON.parse(policy) as { Statement: unknown[] };
    denied.Statement.push({
      Sid: "SpikeF5Deny",
      Effect: "Deny",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: original.Attributes?.QueueArn,
    });
    const setPolicy = (value: string) =>
      sqs.send(
        new SetQueueAttributesCommand({ QueueUrl: o.QueueUrl, Attributes: { Policy: value } }),
      );

    const key = `aws/lambda/spike/f5-${String(Date.now())}`;
    let putAt = 0;
    let restoredAt = 0;
    try {
      await setPolicy(JSON.stringify(denied));
      log("queue policy denies EventBridge; waiting 60s for it to propagate");
      await sleep(60_000);
      putAt = Date.now();
      await s3.send(new PutObjectCommand({ Bucket: o.BucketName, Key: key, Body: "{}" }));
      log(`object written; holding the deny for ${String(holdMinutes)} min`);
      await sleep(holdMinutes * 60_000);
    } finally {
      await setPolicy(policy);
      restoredAt = Date.now();
      log("queue policy restored");
    }
    const message = await waitFor(
      "late signal",
      async () => (await peek(o.QueueUrl, 1)).find((m) => JSON.stringify(m.body).includes(key)),
      30 * 60,
      30,
    );
    save("f5", {
      holdMinutes,
      delivered: message !== undefined,
      secondsPutToMessage: message ? (message.sentAt - putAt) / 1000 : null,
      secondsRestoreToMessage: message ? (message.sentAt - restoredAt) / 1000 : null,
      ruleMetrics: await metricSums("AWS/Events", { RuleName: o.RuleName }, RULE_METRICS, putAt),
      ruleFailedAlarmHistory: await alarmHistory(o.RuleFailedAlarm, putAt),
    });
  },

  /**
   * B: one poison record in a batch of 10, under composureCDK's stream
   * defaults (bisect on, partial batch responses on) and `retryAttempts: 2`.
   * How many failure objects land, which records each holds, how the batch
   * was split, and how long capture took. Run once per processor behaviour:
   * `throw` (the function errors) and `partial` (it reports the record).
   */
  async bisect() {
    const behaviour = process.argv[3] ?? "throw";
    if (behaviour !== "throw" && behaviour !== "partial") {
      throw new Error(`bisect takes throw or partial, not ${behaviour}`);
    }
    const o = await outputs("Bisect");
    await setMode(o.ProcessorName, `${behaviour}:-poison`);
    const run = `bisect-${behaviour}-${String(Date.now())}`;
    const pks = Array.from(
      { length: 10 },
      (_, i) => `${run}-${String(i)}${i === 4 ? "-poison" : ""}`,
    );
    await ddb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [o.TableName]: pks.map((pk) => ({ PutRequest: { Item: item(pk) } })),
        },
      }),
    );
    const putAt = Date.now();
    log(`BatchWriteItem ${run}`);

    // Objects arrive as each split exhausts its retries: wait until none has
    // landed for 3 minutes.
    let objects: { key: string; lastModified: number }[] = [];
    let lastChange = putAt;
    await waitFor(
      "failure objects to settle",
      async () => {
        const now = await objectsSince(o.BucketName, putAt);
        if (now.length !== objects.length) {
          objects = now;
          lastChange = Date.now();
          log(`${String(objects.length)} failure object(s)`);
        }
        return objects.length > 0 && Date.now() - lastChange >= 180_000 ? true : undefined;
      },
      20 * 60,
      15,
    );

    const stored = await Promise.all(
      objects.map(async (object) => {
        const record = JSON.parse(await getObject(o.BucketName, object.key)) as {
          payload?: unknown;
          requestContext?: unknown;
          responseContext?: unknown;
          DDBStreamBatchInfo?: unknown;
        };
        const payload = (
          typeof record.payload === "string" ? JSON.parse(record.payload) : record.payload
        ) as { Records?: { dynamodb?: { Keys?: { pk?: { S?: string } } } }[] } | undefined;
        return {
          key: object.key,
          secondsAfterWrite: (object.lastModified - putAt) / 1000,
          pks: (payload?.Records ?? []).map((r) => r.dynamodb?.Keys?.pk?.S ?? ""),
          requestContext: record.requestContext,
          responseContext: record.responseContext,
          batchInfo: record.DDBStreamBatchInfo,
        };
      }),
    );

    // Each invocation's records, in order: the splits the mapping made.
    const invocations = (await invocationsFor(o.ProcessorLogGroup, run, putAt - 5000))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((i) => ({ secondsAfterWrite: (i.timestamp - putAt) / 1000, pks: i.pks }));

    const storedPks = stored.flatMap((s) => s.pks);
    save(`bisect-${behaviour}`, {
      objectCount: stored.length,
      // Records that reached the bucket though they never failed.
      goodRecordsStored: [...new Set(storedPks.filter((pk) => !pk.endsWith("-poison")))],
      // How often each record was stored: above 1 means duplicate objects.
      timesStored: Object.fromEntries(
        pks.map((pk) => [pk, storedPks.filter((stored) => stored === pk).length]),
      ),
      // How often each record was invoked: above 1 for a good record means it
      // was processed again after a split or a checkpoint.
      timesInvoked: Object.fromEntries(
        pks.map((pk) => [pk, invocations.filter((i) => i.pks.includes(pk)).length]),
      ),
      secondsToLastObject: stored.length
        ? Math.max(...stored.map((s) => s.secondsAfterWrite))
        : null,
      invocations,
      objects: stored,
      esmMetrics: await metricSums(
        "AWS/Lambda",
        { EventSourceMappingUUID: await mappingUuid(o.ProcessorName) },
        ["PolledEventCount", "FailedInvokeEventCount", "OnFailureDestinationDeliveredEventCount"],
        putAt,
      ),
    });
  },

  /** 7: what each stack leaves running, for the idle-cost line. */
  async inventory() {
    const stacks = ["Direct", "EventBridge", "EncCmk", "ShortRetention"];
    const result: Record<string, Record<string, number>> = {};
    for (const stack of stacks) {
      const counts: Record<string, number> = {};
      let nextToken: string | undefined;
      do {
        const out = await cfn.send(
          new ListStackResourcesCommand({ StackName: PREFIX + stack, NextToken: nextToken }),
        );
        for (const r of out.StackResourceSummaries ?? []) {
          counts[r.ResourceType ?? ""] = (counts[r.ResourceType ?? ""] ?? 0) + 1;
        }
        nextToken = out.NextToken;
      } while (nextToken);
      result[stack] = counts;
    }
    save("s7-inventory", result);
  },

  /**
   * Deletes every ComposureLabs-StreamDlq-* stack, then what they leave behind:
   * RETAIN buckets (emptied of every version first) and log groups.
   */
  async teardown() {
    const listed = await cfn.send(new ListStacksCommand({}));
    const stacks = (listed.StackSummaries ?? [])
      .filter((st) => st.StackName?.startsWith(PREFIX) && st.StackStatus !== "DELETE_COMPLETE")
      .map((st) => st.StackName ?? "");
    for (const name of stacks) await cfn.send(new DeleteStackCommand({ StackName: name }));
    log(`deleting ${stacks.join(", ")}`);
    await waitFor(
      "stacks deleted",
      async () => {
        const out = await cfn.send(new ListStacksCommand({}));
        const left = (out.StackSummaries ?? []).filter(
          (st) => stacks.includes(st.StackName ?? "") && st.StackStatus !== "DELETE_COMPLETE",
        );
        if (left.some((st) => st.StackStatus === "DELETE_FAILED")) throw new Error("DELETE_FAILED");
        return left.length === 0 ? true : undefined;
      },
      900,
      15,
    );

    const buckets = ((await s3.send(new ListBucketsCommand({}))).Buckets ?? [])
      .map((b) => b.Name ?? "")
      .filter((name) => name.startsWith(PREFIX.toLowerCase()));
    for (const bucket of buckets) {
      for (;;) {
        const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
        const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(
          (v) => ({
            Key: v.Key,
            VersionId: v.VersionId,
          }),
        );
        if (objects.length === 0) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      log(`deleted bucket ${bucket}`);
    }

    for (const prefix of [PREFIX, `/aws/lambda/${PREFIX}`]) {
      const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }));
      for (const group of groups.logGroups ?? []) {
        await logs.send(new DeleteLogGroupCommand({ logGroupName: group.logGroupName }));
        log(`deleted log group ${group.logGroupName ?? ""}`);
      }
    }
  },
};

const scenario = scenarios[process.argv[2] ?? ""];
if (!scenario) {
  console.error(`usage: node dist/src/run.js <${Object.keys(scenarios).join("|")}> [stack]`);
  process.exit(1);
}
await scenario();
