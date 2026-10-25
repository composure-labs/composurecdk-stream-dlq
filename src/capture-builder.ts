import { Duration, Stack } from "aws-cdk-lib";
import type { CfnBucket } from "aws-cdk-lib/aws-s3";
import type { CfnQueue } from "aws-cdk-lib/aws-sqs";
import type { IConstruct } from "constructs";
import { compose, type Lifecycle, type Ref, ref } from "@composurecdk/core";
import { type ITaggedBuilder, taggedBuilder } from "@composurecdk/cloudformation";
import {
  type IRuleBuilder,
  type RuleBuilderProps,
  type RuleBuilderResult,
  sqsTarget,
} from "@composurecdk/events";
import type { BucketBuilderResult, IBucketBuilder } from "@composurecdk/s3";
import type { IQueueBuilder, QueueBuilderResult } from "@composurecdk/sqs";
import {
  failureBucketDefaults,
  signalQueueDefaults,
  signalRuleDefaults,
  withSignalQueueAlarms,
  withSignalRuleAlarms,
} from "./defaults.js";

/**
 * Configuration for {@link createStreamDlqCaptureBuilder}. Each prop is a
 * callback that receives the component's builder, already set up with
 * capture's defaults, and returns it with the consumer's changes. An omitted
 * callback keeps the defaults.
 */
export interface StreamDlqCaptureBuilderProps {
  /**
   * Customise the failure bucket. Capture keeps EventBridge on, whatever the
   * callback sets, and every expiry rule must outlast the signal queue's
   * retention or the build throws.
   */
  bucket?: (builder: IBucketBuilder) => IBucketBuilder;

  /** Customise the signal queue, a composureCDK `"dlq"`-role queue. */
  queue?: (builder: IQueueBuilder<"dlq">) => IQueueBuilder<"dlq">;

  /**
   * Customise the signal rule. Capture sets its event pattern and its queue
   * target after the callback. Alarms set with `recommendedAlarms` override
   * capture's field by field, as they do on the queue.
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
    const queue = withSignalQueueAlarms(configured(signalQueueDefaults(), this.props.queue));
    const rule = withSignalRuleAlarms(configured(signalRuleDefaults(), this.props.rule));

    // The signal path, set after the callbacks so none of it can be removed:
    // the bucket publishes its events to EventBridge, and the rule routes this
    // bucket's Object Created events to the queue.
    return compose(
      {
        bucket: bucket.eventBridgeEnabled(true),
        queue,
        rule: withEventPattern(
          rule.addTarget("queue", sqsTarget(ref<QueueBuilderResult>("queue").get("queue"))),
          ref<BucketBuilderResult>("bucket").map(({ bucket }) => ({
            source: ["aws.s3"],
            detailType: ["Object Created"],
            detail: { bucket: { name: [bucket.bucketName] } },
          })),
        ),
      },
      { bucket: [], queue: [], rule: ["bucket", "queue"] },
    )
      .afterBuild(checkLifetimes)
      .build(scope, id, context);
  }
}

/** The consumer's callback applied to a copy of the defaults, so capture owns what it then changes. */
function configured<B extends { copy(): B }>(
  defaults: B,
  configure: ((builder: B) => B) | undefined,
): B {
  return (configure?.(defaults) ?? defaults).copy();
}

/**
 * Builds `rule` with the event pattern `pattern` resolves to.
 *
 * Interim: the rule builder's `eventPattern` can't take a `ref` yet. Once
 * laazyj/composureCDK#637 lands, this becomes `rule.eventPattern(pattern)`.
 */
function withEventPattern(
  rule: IRuleBuilder,
  pattern: Ref<NonNullable<RuleBuilderProps["eventPattern"]>>,
): Lifecycle<RuleBuilderResult> {
  return {
    build(scope: IConstruct, id: string, context: Record<string, object>): RuleBuilderResult {
      return rule.eventPattern(pattern.resolve(context)).build(scope, id, context);
    },
  };
}

/**
 * Throws if an enabled expiry rule on the failure bucket deletes objects
 * before the signal queue's retention ends, so a failure would be gone while
 * its signal is still waiting (architecture D5). Reads the resolved L1
 * properties, so it checks what will deploy. Rules with a filter are checked too, since
 * one may match failures.
 */
function checkLifetimes(
  _scope: IConstruct,
  _id: string,
  { bucket, queue }: Pick<StreamDlqCaptureResult, "bucket" | "queue">,
): void {
  const stack = Stack.of(queue.queue);
  const retention = Duration.seconds(
    stack.resolve((queue.queue.node.defaultChild as CfnQueue).messageRetentionPeriod) as number,
  );
  const lifecycle = stack.resolve(
    (bucket.bucket.node.defaultChild as CfnBucket).lifecycleConfiguration,
  ) as { rules?: CfnBucket.RuleProperty[] } | undefined;

  for (const rule of lifecycle?.rules ?? []) {
    if (rule.status !== "Enabled" || rule.expirationInDays === undefined) continue;
    const expiration = Duration.days(rule.expirationInDays);
    if (expiration.toSeconds() <= retention.toSeconds()) {
      throw new Error(
        `Stream DLQ capture: lifecycle rule "${rule.id ?? "(unnamed)"}" expires objects after ` +
          `${expiration.toHumanString()}, which must be longer than the signal queue's ` +
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
