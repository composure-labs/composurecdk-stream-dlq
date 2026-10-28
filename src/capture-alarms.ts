import { type Alarm, ComparisonOperator, Metric } from "aws-cdk-lib/aws-cloudwatch";
import type { Rule } from "aws-cdk-lib/aws-events";
import type { Queue } from "aws-cdk-lib/aws-sqs";
import { Stack } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { Lifecycle, Ref } from "@composurecdk/core";
import {
  type AlarmConfig,
  type AlarmConfigDefaults,
  type AlarmDefinition,
  type AlarmName,
  createAlarms,
  defaultAlarmName,
  resolveAlarmConfig,
  resolveAlarmThresholdBasis,
} from "@composurecdk/cloudwatch";
import {
  DEFAULT_CAPTURE_ALARM_PERIOD,
  DEFAULT_CAPTURE_ALARMS,
  DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO,
} from "./defaults.js";
import { signalQueueRetentionSeconds } from "./signal-queue.js";

/**
 * Capture's alarms, set with the capture builder's `recommendedAlarms`. Each
 * alarm's config merges over capture's defaults field by field; `false` turns
 * that alarm off.
 */
export interface StreamDlqCaptureAlarmConfig {
  /** `false` turns every capture alarm off. @default true */
  enabled?: boolean;

  /** A failure is waiting: any visible message on the signal queue. */
  failuresWaiting?: AlarmConfig | false;

  /**
   * A failure has waited for most of the signal's lifetime: the oldest message
   * is at least 75% of the queue's retention old, the last warning before SQS
   * deletes the signal.
   */
  failuresAgeing?: AlarmConfig | false;

  /**
   * A failure was stored but not signalled: the rule's `FailedInvocations`,
   * when EventBridge gives up delivering to the queue.
   */
  signalUndelivered?: AlarmConfig | false;
}

/** Both queue metrics are gauges, so the alarms take each minute's peak. */
const QUEUE_GAUGE = { period: DEFAULT_CAPTURE_ALARM_PERIOD, statistic: "Maximum" };

/**
 * Capture's alarms over the built `queue` and `rule`. The age alarm's default
 * threshold is derived from the queue's retention, so it tracks whatever
 * retention the queue was given. When that retention is a token, the age alarm
 * is skipped with a warning unless the consumer sets its threshold.
 */
export function captureAlarms(
  config: StreamDlqCaptureAlarmConfig | false | undefined,
  sources: { queue: Ref<Queue>; rule: Ref<Rule> },
): Lifecycle<Record<string, Alarm>> {
  return {
    build(scope: IConstruct, id: string, context: Record<string, object>): Record<string, Alarm> {
      if (config === false || config?.enabled === false) return {};
      const queue = sources.queue.resolve(context);
      const rule = sources.rule.resolve(context);

      const definitions: AlarmDefinition[] = [];
      const define = (
        key: keyof Omit<StreamDlqCaptureAlarmConfig, "enabled">,
        defaults: AlarmConfigDefaults,
        rest: Pick<AlarmDefinition, "metric" | "comparisonOperator" | "description">,
      ): void => {
        const user = config?.[key];
        if (user === false) return;
        const resolved = resolveAlarmConfig(user, defaults);
        definitions.push({
          key,
          ...resolved,
          alarmName: resolved.alarmName ?? captureAlarmName(scope, key),
          ...rest,
        });
      };

      define("failuresWaiting", DEFAULT_CAPTURE_ALARMS.failuresWaiting, {
        metric: queue.metricApproximateNumberOfMessagesVisible(QUEUE_GAUGE),
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        description:
          "A stream failure is waiting on the signal queue. Recover it from the failure bucket.",
      });
      const ageing = config?.failuresAgeing;
      const ageThreshold =
        ageing === false ? undefined : (ageing?.threshold ?? defaultAgeThreshold(queue));
      if (ageThreshold !== undefined) {
        define(
          "failuresAgeing",
          { ...DEFAULT_CAPTURE_ALARMS.failuresAgeing, threshold: ageThreshold },
          {
            metric: queue.metricApproximateAgeOfOldestMessage(QUEUE_GAUGE),
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            description:
              "A stream failure's signal is close to expiry. Once SQS deletes it the alarms clear, " +
              "but the failure stays in the bucket.",
          },
        );
      }
      define("signalUndelivered", DEFAULT_CAPTURE_ALARMS.signalUndelivered, {
        metric: new Metric({
          namespace: "AWS/Events",
          metricName: "FailedInvocations",
          dimensionsMap: { RuleName: rule.ruleName },
          period: DEFAULT_CAPTURE_ALARM_PERIOD,
          statistic: "Sum",
        }),
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        description:
          "A stream failure was stored but not signalled. List the failure bucket by " +
          "LastModified across the alarm's window to find it.",
      });

      return createAlarms(scope, id, definitions);
    },
  };
}

/**
 * `<stack>/<path to the capture>/<key>`. composureCDK's default names an alarm
 * `<stack>/<id>/<key>`, ignoring the constructs between the stack and its
 * scope, so every capture's "alarms" component would share one name per key.
 * Interim, until that default includes the path.
 */
function captureAlarmName(capture: IConstruct, key: string): AlarmName {
  const { scopes } = capture.node;
  const below = scopes.slice(scopes.indexOf(Stack.of(capture)) + 1);
  return defaultAlarmName(capture, below.map((c) => c.node.id).join("/"), key);
}

/**
 * {@link DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO} of the queue's retention, or
 * `undefined`, with a warning, when the retention is a token.
 */
function defaultAgeThreshold(queue: Queue): number | undefined {
  const retentionSeconds = resolveAlarmThresholdBasis({
    scope: queue,
    value: signalQueueRetentionSeconds(queue),
    resolve: (seconds) => seconds,
    warningId: "@composure-labs/composurecdk-stream-dlq:age-alarm-token-retention",
    alarmLabel: "stream failure ageing",
    suppressHint: "recommendedAlarms({ failuresAgeing: false }), or by setting its threshold",
  });
  return retentionSeconds === undefined
    ? undefined
    : Math.round(retentionSeconds * DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO);
}
