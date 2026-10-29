import { Annotations, Duration, Names, Stack, Token } from "aws-cdk-lib";
import type { Alarm } from "aws-cdk-lib/aws-cloudwatch";
import type { CfnBucket } from "aws-cdk-lib/aws-s3";
import type { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct, type IConstruct } from "constructs";
import { at, compose, type Lifecycle, type Ref, ref } from "@composurecdk/core";
import { type ITaggedBuilder, taggedBuilder } from "@composurecdk/cloudformation";
import {
  type IRuleBuilder,
  type RuleBuilderProps,
  type RuleBuilderResult,
} from "@composurecdk/events";
import type { BucketBuilderResult, IBucketBuilder } from "@composurecdk/s3";
import type { IQueueBuilder, QueueBuilderResult } from "@composurecdk/sqs";
import { captureAlarms, type StreamDlqCaptureAlarmConfig } from "./capture-alarms.js";
import { failureBucketDefaults, signalQueueDefaults, signalRuleDefaults } from "./defaults.js";
import { signalQueueRetentionSeconds } from "./signal-queue.js";
import { signalTarget } from "./signal-target.js";

/**
 * Configuration for {@link createStreamDlqCaptureBuilder}.
 *
 * `recommendedAlarms` tunes capture's own alarms. The `bucket`, `queue` and
 * `rule` callbacks are the lower-level route: each receives the component's
 * builder, already set up with capture's defaults, and returns it with the
 * consumer's changes.
 */
export interface StreamDlqCaptureBuilderProps {
  /**
   * Capture's alarms: failures waiting, failures ageing and signals
   * undelivered. `false` turns them all off.
   */
  recommendedAlarms?: StreamDlqCaptureAlarmConfig | false;

  /**
   * Customise the failure bucket. Capture keeps EventBridge on, whatever the
   * callback sets, and every expiry rule must outlast the signal queue's
   * retention or the build throws.
   */
  bucket?: (builder: IBucketBuilder) => IBucketBuilder;

  /**
   * Customise the signal queue, a composureCDK `"dlq"`-role queue. Its own
   * recommended alarms are off because capture's replace them; turning them
   * back on duplicates capture's. Add other alarms with `addAlarm`.
   */
  queue?: (builder: IQueueBuilder<"dlq">) => IQueueBuilder<"dlq">;

  /**
   * Customise the signal rule. Capture sets its event pattern and its queue
   * target after the callback. Its own recommended alarms are off, as on the
   * queue.
   */
  rule?: (builder: IRuleBuilder) => IRuleBuilder;
}

/** Everything the capture builder creates, as each component's builder returns it. */
export interface StreamDlqCaptureResult {
  /** The failure bucket and its access-logs bucket. */
  bucket: BucketBuilderResult;
  /** The signal queue. */
  queue: QueueBuilderResult;
  /** The signal rule and its queue target. */
  rule: RuleBuilderResult;
  /**
   * Capture's alarms, keyed `failuresWaiting`, `failuresAgeing` and
   * `signalUndelivered`. No actions are configured.
   */
  alarms: Record<string, Alarm>;
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
    // The signal path is set after the callbacks, so none of it can be removed:
    // the bucket publishes its events to EventBridge, and the rule routes this
    // bucket's Object Created events to the queue.
    //
    // Everything capture creates is built under one construct named `id`, each
    // component under its key. Until compose() treats an empty id as no prefix
    // (laazyj/composureCDK#644), the keys are pinned with at(); dropping
    // pinnedToKeys then leaves every path, and so every logical id, unchanged.
    return compose(
      pinnedToKeys({
        bucket: configured(failureBucketDefaults(), this.props.bucket).eventBridgeEnabled(true),
        queue: configured(signalQueueDefaults(), this.props.queue),
        rule: signalRule(
          configured(signalRuleDefaults(), this.props.rule),
          ref<BucketBuilderResult>("bucket").map(({ bucket }) => ({
            source: ["aws.s3"],
            detailType: ["Object Created"],
            detail: { bucket: { name: [bucket.bucketName] } },
          })),
          ref<QueueBuilderResult>("queue").get("queue"),
        ),
        alarms: captureAlarms(this.props.recommendedAlarms, {
          queue: ref<QueueBuilderResult>("queue").get("queue"),
          rule: ref<RuleBuilderResult>("rule").get("rule"),
        }),
      }),
      { bucket: [], queue: [], rule: ["bucket", "queue"], alarms: ["queue", "rule"] },
    )
      .afterBuild(checkLifetimes)
      .build(new Construct(scope, id), "", context);
  }
}

/** Pins each component's construct id to its key, so compose() adds no prefix. */
function pinnedToKeys<C extends Record<string, Lifecycle>>(components: C): C {
  return Object.fromEntries(
    Object.entries(components).map(([key, component]) => [key, at(key, component)]),
  ) as C;
}

/**
 * The consumer's callback applied to capture's defaults, copied so capture
 * owns what it then changes.
 */
function configured<B extends { copy(): B }>(
  defaults: B,
  configure: ((builder: B) => B) | undefined,
): B {
  return (configure?.(defaults) ?? defaults).copy();
}

/**
 * Builds `rule` with the event pattern `pattern` resolves to and the queue as
 * its target. With a customer-managed queue key, the rule needs a literal
 * name for the key's policy to scope to ({@link signalTarget}), so capture
 * names it from its path unless the consumer has.
 *
 * Interim: the rule builder's `eventPattern` can't take a `ref` yet. Once
 * laazyj/composureCDK#637 lands, the pattern becomes `rule.eventPattern(pattern)`.
 */
function signalRule(
  rule: IRuleBuilder,
  pattern: Ref<NonNullable<RuleBuilderProps["eventPattern"]>>,
  queue: Ref<Queue>,
): Lifecycle<RuleBuilderResult> {
  return {
    build(scope: IConstruct, id: string, context: Record<string, object>): RuleBuilderResult {
      const resolved = queue.resolve(context);
      let name: string | undefined;
      if (resolved.encryptionMasterKey !== undefined) {
        name =
          rule.ruleName() ??
          `${Names.uniqueResourceName(scope, { maxLength: 63 - id.length, separator: "-" })}-${id}`;
        if (Token.isUnresolved(name)) {
          throw new Error(
            "Stream DLQ capture: the signal rule's name is a token, so the queue key's policy " +
              "can't be scoped to the rule without a dependency cycle. Give it a literal name.",
          );
        }
        rule.ruleName(name);
      }
      return rule
        .eventPattern(pattern.resolve(context))
        .addTarget("queue", signalTarget(resolved, name))
        .build(scope, id, context);
    },
  };
}

/**
 * Throws if an enabled expiry rule on the failure bucket deletes objects
 * before the signal queue's retention ends, so a failure would be gone while
 * its signal is still waiting (architecture D5). Reads the resolved L1
 * properties, so it checks what will deploy. Rules with a filter are checked
 * too, since one may match failures. A token retention can't be compared, so
 * the check is skipped with a warning.
 */
function checkLifetimes(
  _scope: IConstruct,
  _id: string,
  { bucket, queue }: Pick<StreamDlqCaptureResult, "bucket" | "queue">,
): void {
  const retentionSeconds = signalQueueRetentionSeconds(queue.queue);
  if (Token.isUnresolved(retentionSeconds)) {
    Annotations.of(queue.queue).addWarningV2(
      "@composure-labs/composurecdk-stream-dlq:lifetime-check-token-retention",
      "Stream DLQ capture can't check that the failure bucket's expiry outlasts the signal " +
        "queue's retention, because the retention is an unresolved token.",
    );
    return;
  }
  const retention = Duration.seconds(retentionSeconds);
  const lifecycle = Stack.of(bucket.bucket).resolve(
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
 * reaches the signal queue through EventBridge, and capture's alarms raise
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
