import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import type { AlarmConfigDefaults } from "@composurecdk/cloudwatch";
import { createRuleBuilder, type IRuleBuilder } from "@composurecdk/events";
import { BlockPublicAccess, BucketEncryption, type LifecycleRule } from "aws-cdk-lib/aws-s3";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { createBucketBuilder, type IBucketBuilder } from "@composurecdk/s3";
import { createQueueBuilder, type IQueueBuilder } from "@composurecdk/sqs";

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

/** The period of each capture alarm's metric: 1 minute, the finest SQS and EventBridge publish. */
export const DEFAULT_CAPTURE_ALARM_PERIOD = Duration.minutes(1);

/**
 * Each capture alarm's defaults: alarm on any occurrence, from one datapoint,
 * with missing data not breaching. `failuresAgeing` has no fixed threshold:
 * capture sets it to {@link DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO} of the
 * queue's retention at build.
 */
export const DEFAULT_CAPTURE_ALARMS: {
  failuresWaiting: AlarmConfigDefaults;
  failuresAgeing: Omit<AlarmConfigDefaults, "threshold">;
  signalUndelivered: AlarmConfigDefaults;
} = {
  failuresWaiting: {
    threshold: 0,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  },
  failuresAgeing: {
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  },
  signalUndelivered: {
    threshold: 0,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  },
};

// Everything below sets each value capture documents or checks, even where
// composureCDK's own default is the same today. A consumer's peers can resolve
// to a later composureCDK than this package was tested with, so an inherited
// default could change under them and make the README or the lifetime check
// wrong.

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

/**
 * The signal queue's builder, before the consumer's `queue` callback. Its
 * recommended alarms are off: capture's alarms replace them.
 */
export function signalQueueDefaults(): IQueueBuilder<"dlq"> {
  return createQueueBuilder("dlq")
    .retentionPeriod(DEFAULT_SIGNAL_QUEUE_RETENTION)
    .visibilityTimeout(DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT)
    .encryption(QueueEncryption.SQS_MANAGED)
    .recommendedAlarms(false);
}

/**
 * The signal rule's builder, before the consumer's `rule` callback. Its
 * recommended alarms are off: capture's alarms replace them.
 */
export function signalRuleDefaults(): IRuleBuilder {
  return createRuleBuilder()
    .description("Signals each stream failure written to the failure bucket")
    .recommendedAlarms(false);
}
