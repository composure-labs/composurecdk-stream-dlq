import type { Duration } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { compose, type Lifecycle, ref } from "@composurecdk/core";
import { type ITaggedBuilder, taggedBuilder } from "@composurecdk/cloudformation";
import { type IRuleBuilder, type RuleBuilderResult, sqsTarget } from "@composurecdk/events";
import type { BucketBuilderResult, IBucketBuilder } from "@composurecdk/s3";
import { DLQ_QUEUE_DEFAULTS, type IQueueBuilder, type QueueBuilderResult } from "@composurecdk/sqs";
import {
  failureBucketDefaults,
  SIGNAL_RULE_ALARMS,
  signalQueueAlarms,
  signalQueueDefaults,
  signalRuleDefaults,
} from "./defaults.js";

/**
 * Configuration for {@link createStreamDlqCaptureBuilder}. Each prop is a
 * callback that receives the component's builder, already set up with
 * capture's defaults, and returns it with the consumer's changes. An omitted
 * callback keeps the defaults.
 */
export interface StreamDlqCaptureBuilderProps {
  /**
   * Customise the failure bucket. EventBridge must stay on, and every expiry
   * rule must outlast the signal queue's retention. `build()` throws otherwise.
   */
  bucket?: (builder: IBucketBuilder) => IBucketBuilder;

  /** Customise the signal queue, a composureCDK `"dlq"`-role queue. */
  queue?: (builder: IQueueBuilder<"dlq">) => IQueueBuilder<"dlq">;

  /**
   * Customise the signal rule. Capture sets its event pattern and its queue
   * target. Alarms set with `recommendedAlarms` override capture's alarm by
   * alarm, as they do on the queue.
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
export type IStreamDlqCaptureBuilder = ITaggedBuilder<
  StreamDlqCaptureBuilderProps,
  StreamDlqCaptureBuilder
>;

class StreamDlqCaptureBuilder implements Lifecycle<StreamDlqCaptureResult> {
  props: Partial<StreamDlqCaptureBuilderProps> = {};

  build(scope: IConstruct, id: string, context?: Record<string, object>): StreamDlqCaptureResult {
    const bucket = configured(failureBucketDefaults(), this.props.bucket);
    const configuredQueue = configured(signalQueueDefaults(), this.props.queue);
    const configuredRule = configured(
      signalRuleDefaults().addTarget(
        "queue",
        sqsTarget(ref<QueueBuilderResult>("queue").get("queue")),
      ),
      this.props.rule,
    );

    // Unset only on a replacement builder a callback returned, which gets the role's retention.
    const retention = configuredQueue.retentionPeriod() ?? DLQ_QUEUE_DEFAULTS.retentionPeriod;
    checkSignalPath(bucket, retention);

    // Alarms go on after the callbacks, so the age alarm tracks the final
    // retention, and on copies, so a builder a callback returned is untouched.
    const queue = configuredQueue
      .copy()
      .recommendedAlarms(
        underConsumer(signalQueueAlarms(retention), configuredQueue.recommendedAlarms()),
      );
    const rule = configuredRule
      .copy()
      .recommendedAlarms(underConsumer(SIGNAL_RULE_ALARMS, configuredRule.recommendedAlarms()));

    return compose(
      { bucket, queue, rule: withFailureBucketPattern(rule) },
      { bucket: [], queue: [], rule: ["bucket", "queue"] },
    ).build(scope, id, context);
  }
}

function configured<B>(defaults: B, configure: ((builder: B) => B) | undefined): B {
  return configure?.(defaults) ?? defaults;
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

/**
 * Adds the failure bucket's `Object Created` pattern to the rule at build,
 * once the bucket's name can be resolved.
 *
 * Interim: the rule builder's `eventPattern` can't take a `ref` yet. Once
 * laazyj/composureCDK#637 lands, replace this with `.eventPattern(ref(...))`
 * applied after the consumer's `rule` callback, as here, so the pattern still
 * can't be overridden.
 */
function withFailureBucketPattern(rule: IRuleBuilder): Lifecycle<RuleBuilderResult> {
  return {
    build(scope: IConstruct, id: string, context: Record<string, object>): RuleBuilderResult {
      const bucket = ref<BucketBuilderResult>("bucket").get("bucket").resolve(context);
      // `rule` is capture's own copy, so setting the pattern on it is safe.
      return rule
        .eventPattern({
          source: ["aws.s3"],
          detailType: ["Object Created"],
          detail: { bucket: { name: [bucket.bucketName] } },
        })
        .build(scope, id, context);
    },
  };
}

/**
 * Throws when the configured bucket and queue would break the signal path:
 * EventBridge switched off, so no failure is ever signalled, or an expiry rule
 * that deletes an object while its signal is still on the queue (architecture
 * D5). Rules with a filter are checked too, since one may match failures.
 */
function checkSignalPath(bucket: IBucketBuilder, retention: Duration): void {
  if (bucket.eventBridgeEnabled() !== true) {
    throw new Error(
      "Stream DLQ capture: the failure bucket must keep eventBridgeEnabled, " +
        "or no failure is ever signalled.",
    );
  }
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
 * The bucket is RETAINed, so keep `id` stable. The README lists what is built.
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
  return taggedBuilder<StreamDlqCaptureBuilderProps, StreamDlqCaptureBuilder>(
    StreamDlqCaptureBuilder,
  );
}
