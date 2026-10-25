import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { createRuleBuilder, type IRuleBuilder, type RuleAlarmConfig } from "@composurecdk/events";
import { BlockPublicAccess, BucketEncryption, type LifecycleRule } from "aws-cdk-lib/aws-s3";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { createBucketBuilder, type IBucketBuilder } from "@composurecdk/s3";
import {
  createQueueBuilder,
  DLQ_QUEUE_DEFAULTS,
  type IQueueBuilder,
  type QueueAlarmConfig,
} from "@composurecdk/sqs";

/**
 * Lifecycle rules for the failure bucket. They replace composureCDK's bucket
 * defaults, whose noncurrent-version rule has nothing to act on with
 * versioning off.
 *
 * - Failure objects expire after 90 days. That must stay longer than the signal
 *   queue's retention, which the capture builder checks at build.
 * - Incomplete multipart uploads are aborted after 7 days, copied from
 *   composureCDK's bucket defaults, which don't export the rule on its own.
 */
export const DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES: LifecycleRule[] = [
  {
    id: "AbortIncompleteMultipartUploadAfter7Days",
    abortIncompleteMultipartUploadAfter: Duration.days(7),
  },
  {
    id: "ExpireFailuresAfter90Days",
    expiration: Duration.days(90),
  },
];

/** Signal queue retention: 14 days, the SQS maximum, so a signal waits as long as it can. */
export const DEFAULT_SIGNAL_QUEUE_RETENTION = Duration.days(14);

/**
 * Visibility timeout for the signal queue: 1 minute, so a message that a
 * crashed or failed consumer received becomes visible again promptly.
 */
export const DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT = Duration.minutes(1);

/**
 * Fraction of the signal queue's retention at which the age alarm fires: the
 * last warning before SQS deletes the signal.
 */
export const DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO = 0.75;

// Everything below sets each value capture documents or checks, even where
// composureCDK's own default is the same today. A consumer's peers can resolve
// to a later composureCDK than this package was tested with, so an inherited
// default could change under them and make the README or the lifetime check
// wrong.

const ALARM_ON_ANY = {
  threshold: 0,
  evaluationPeriods: 1,
  datapointsToAlarm: 1,
  treatMissingData: TreatMissingData.NOT_BREACHING,
};

/** The failure bucket's builder, before the consumer's `bucket` callback. */
export function failureBucketDefaults(): IBucketBuilder {
  return createBucketBuilder()
    .versioned(false)
    .lifecycleRules(DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES)
    .removalPolicy(RemovalPolicy.RETAIN)
    .encryption(BucketEncryption.S3_MANAGED)
    .enforceSSL(true)
    .blockPublicAccess(BlockPublicAccess.BLOCK_ALL)
    .serverAccessLogs({ prefix: "logs/" });
}

/** The signal queue's builder, before the consumer's `queue` callback. */
export function signalQueueDefaults(): IQueueBuilder<"dlq"> {
  return createQueueBuilder("dlq")
    .retentionPeriod(DEFAULT_SIGNAL_QUEUE_RETENTION)
    .visibilityTimeout(DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT)
    .encryption(QueueEncryption.SQS_MANAGED);
}

/** The signal rule's builder, before the consumer's `rule` callback. */
export function signalRuleDefaults(): IRuleBuilder {
  return createRuleBuilder().description(
    "Signals each stream failure written to the failure bucket",
  );
}

/**
 * Applies the signal queue's alarms under any the consumer set. Called after
 * the consumer's callback, so the age alarm tracks the queue's final retention.
 */
export function withSignalQueueAlarms(queue: IQueueBuilder<"dlq">): IQueueBuilder<"dlq"> {
  // Unset only on a replacement builder a callback returned, which gets the role's retention.
  const retention = queue.retentionPeriod() ?? DLQ_QUEUE_DEFAULTS.retentionPeriod;
  const alarms: QueueAlarmConfig = {
    // Any message is a failure that needs attention.
    approximateNumberOfMessagesVisible: ALARM_ON_ANY,
    approximateAgeOfOldestMessage: {
      ...ALARM_ON_ANY,
      threshold: Math.round(retention.toSeconds() * DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO),
    },
    // Nothing normally holds a signal in flight.
    approximateNumberOfMessagesNotVisible: false,
  };
  return queue.recommendedAlarms(underConsumer(alarms, queue.recommendedAlarms()));
}

/** Applies the signal rule's alarms under any the consumer set. */
export function withSignalRuleAlarms(rule: IRuleBuilder): IRuleBuilder {
  const alarms: RuleAlarmConfig = {
    // A signal EventBridge gave up delivering: the failure is stored but unsignalled.
    failedInvocations: ALARM_ON_ANY,
    // Throttling only delays delivery: EventBridge keeps retrying for 24 hours,
    // and a signal it gives up on raises failedInvocations.
    throttledRules: false,
    // The target has no dead-letter queue (architecture D2), so these never
    // emit. Revisit once laazyj/composureCDK#636 makes them conditional.
    invocationsSentToDlq: false,
    invocationsFailedToBeSentToDlq: false,
  };
  return rule.recommendedAlarms(underConsumer(alarms, rule.recommendedAlarms()));
}

/**
 * Capture's alarm config with the consumer's on top, field by field, so a
 * field the consumer leaves out keeps capture's value rather than falling back
 * to the library's. `false`, for all alarms or for one, wins outright.
 */
function underConsumer<C extends object>(capture: C, consumer: C | false | undefined): C | false {
  if (consumer === false) return false;
  const merged: Record<string, unknown> = { ...(capture as Record<string, unknown>) };
  for (const [key, value] of Object.entries(consumer ?? {})) {
    const pinned = merged[key];
    merged[key] = isObject(pinned) && isObject(value) ? { ...pinned, ...value } : value;
  }
  return merged as C;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
