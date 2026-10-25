import type { IConstruct } from "constructs";
import { Builder, type IBuilder, type Lifecycle } from "@composurecdk/core";
import {
  createRuleBuilder,
  type IRuleBuilder,
  type RuleBuilderResult,
  sqsTarget,
} from "@composurecdk/events";
import {
  type BucketBuilderResult,
  createBucketBuilder,
  type IBucketBuilder,
} from "@composurecdk/s3";
import {
  createQueueBuilder,
  DLQ_QUEUE_DEFAULTS,
  type IQueueBuilder,
  type QueueBuilderResult,
} from "@composurecdk/sqs";
import {
  DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES,
  DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT,
} from "./defaults.js";

/**
 * Configuration for {@link createStreamDlqCaptureBuilder}. Each prop is a
 * callback that receives the component's builder, already set up with
 * capture's defaults, and returns it with the consumer's changes. An omitted
 * callback keeps the defaults.
 */
export interface StreamDlqCaptureBuilderProps {
  /**
   * Customise the failure bucket. The builder arrives with versioning off,
   * {@link DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES} and EventBridge on, over
   * composureCDK's bucket defaults.
   *
   * EventBridge must stay on, and every expiry rule must outlast the signal
   * queue's retention. `build()` throws otherwise.
   */
  bucket?: (builder: IBucketBuilder) => IBucketBuilder;

  /**
   * Customise the signal queue. The builder arrives in composureCDK's `"dlq"`
   * role with {@link DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT}.
   */
  queue?: (builder: IQueueBuilder<"dlq">) => IQueueBuilder<"dlq">;

  /**
   * Customise the rule that turns each failure object into a signal. The
   * builder arrives with the bucket's `Object Created` pattern, the queue as
   * its target, and only the `failedInvocations` alarm. Setting
   * `recommendedAlarms` replaces that alarm configuration.
   */
  rule?: (builder: IRuleBuilder) => IRuleBuilder;
}

/** Everything the capture builder creates, as each component's builder returns it. */
export interface StreamDlqCaptureResult {
  /** The failure bucket, its access-logs bucket and its alarms. */
  bucket: BucketBuilderResult;
  /** The signal queue and its depth and age alarms. */
  queue: QueueBuilderResult;
  /** The signal rule, its queue target and its `failedInvocations` alarm. */
  rule: RuleBuilderResult;
}

/**
 * A fluent builder for stream failure capture: a failure bucket for an event
 * source mapping's on-failure destination, and an SQS signal of each failure
 * that can be alarmed on. See {@link StreamDlqCaptureBuilderProps}.
 */
export type IStreamDlqCaptureBuilder = IBuilder<
  StreamDlqCaptureBuilderProps,
  StreamDlqCaptureBuilder
>;

class StreamDlqCaptureBuilder implements Lifecycle<StreamDlqCaptureResult> {
  props: Partial<StreamDlqCaptureBuilderProps> = {};

  build(scope: IConstruct, id: string, context?: Record<string, object>): StreamDlqCaptureResult {
    const bucketDefaults = createBucketBuilder()
      .versioned(false)
      .lifecycleRules(DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES)
      .eventBridgeEnabled(true);
    const bucketBuilder = this.props.bucket?.(bucketDefaults) ?? bucketDefaults;

    const queueDefaults = createQueueBuilder("dlq").visibilityTimeout(
      DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT,
    );
    const queueBuilder = this.props.queue?.(queueDefaults) ?? queueDefaults;

    checkSignalPath(bucketBuilder, queueBuilder);

    const bucket = bucketBuilder.build(scope, `${id}Bucket`, context);
    const queue = queueBuilder.build(scope, `${id}Queue`, context);

    const ruleDefaults = createRuleBuilder()
      .description("Signals each stream failure written to the failure bucket")
      .eventPattern({
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: { bucket: { name: [bucket.bucket.bucketName] } },
      })
      .addTarget("queue", sqsTarget(queue.queue))
      .recommendedAlarms({
        // Throttling only delays delivery: EventBridge keeps retrying for 24 hours,
        // and a signal it gives up on raises failedInvocations.
        throttledRules: false,
        // The target has no dead-letter queue (architecture D2), so these never emit.
        invocationsSentToDlq: false,
        invocationsFailedToBeSentToDlq: false,
      });
    const rule = (this.props.rule?.(ruleDefaults) ?? ruleDefaults).build(
      scope,
      `${id}Rule`,
      context,
    );

    return { bucket, queue, rule };
  }
}

/**
 * Throws when the configured bucket and queue would break the signal path:
 * EventBridge switched off, so no failure is ever signalled, or an expiry rule
 * that deletes an object while its signal is still on the queue (architecture
 * D5). Rules with a filter are checked too, since one may match failures.
 */
function checkSignalPath(bucket: IBucketBuilder, queue: IQueueBuilder<"dlq">): void {
  if (bucket.eventBridgeEnabled() !== true) {
    throw new Error(
      "Stream DLQ capture: the failure bucket must keep eventBridgeEnabled, " +
        "or no failure is ever signalled.",
    );
  }
  const retention = queue.retentionPeriod() ?? DLQ_QUEUE_DEFAULTS.retentionPeriod;
  for (const rule of bucket.lifecycleRules() ?? []) {
    if (rule.enabled === false || rule.expiration === undefined) continue;
    if (rule.expiration.toSeconds() <= retention.toSeconds()) {
      throw new Error(
        `Stream DLQ capture: lifecycle rule "${rule.id ?? "(unnamed)"}" expires objects after ` +
          `${rule.expiration.toHumanString()}, which must be longer than the signal queue's ` +
          `retention (${retention.toHumanString()}). Otherwise a failure is deleted while ` +
          "its signal is still waiting.",
      );
    }
  }
}

/**
 * Creates a builder for stream failure capture. An event source mapping writes
 * each failed batch to the failure bucket; the bucket's `Object Created` event
 * reaches the signal queue through EventBridge, and the queue's alarms raise
 * it. Name the bucket as the mapping's on-failure destination.
 *
 * Construct ids are prefixed with `id`, and the bucket is RETAINed, so keep
 * `id` stable. The README lists what is built.
 *
 * @example
 * ```ts
 * compose(
 *   {
 *     failures: createStreamDlqCaptureBuilder(),
 *     processor: createFunctionBuilder(), // ...with the bucket as onFailure
 *   },
 *   { failures: [], processor: ["failures"] },
 * );
 * ```
 */
export function createStreamDlqCaptureBuilder(): IStreamDlqCaptureBuilder {
  return Builder<StreamDlqCaptureBuilderProps, StreamDlqCaptureBuilder>(StreamDlqCaptureBuilder);
}
