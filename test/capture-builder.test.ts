import { App, CfnParameter, Duration, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { compose } from "@composurecdk/core";
import { assertCopyPreservesState } from "@composurecdk/core/testing";
import { createBucketBuilder } from "@composurecdk/s3";
import { createQueueBuilder } from "@composurecdk/sqs";
import {
  createStreamDlqCaptureBuilder,
  type IStreamDlqCaptureBuilder,
  type StreamDlqCaptureResult,
} from "../src/index.js";

function synth(builder: IStreamDlqCaptureBuilder = createStreamDlqCaptureBuilder()): {
  result: StreamDlqCaptureResult;
  template: Template;
} {
  const stack = new Stack(new App(), "Test");
  const result = builder.build(stack, "Failures");
  return { result, template: Template.fromStack(stack) };
}

/** Builds without synthesising, for tests that only care whether build() throws. */
function build(builder: IStreamDlqCaptureBuilder): StreamDlqCaptureResult {
  return builder.build(new Stack(new App(), "Test"), "Failures");
}

function logicalIds(template: Template, type: string): string[] {
  return Object.keys(template.findResources(type)).sort();
}

describe("createStreamDlqCaptureBuilder", () => {
  describe("defaults", () => {
    const { result, template } = synth();

    it("pins its logical ids, which the retained bucket depends on", () => {
      expect(logicalIds(template, "AWS::S3::Bucket")).toEqual([
        "Failuresbucket5560B8FC",
        "FailuresbucketAccessLogs3A7592D3",
      ]);
      expect(logicalIds(template, "AWS::SQS::Queue")).toEqual(["Failuresqueue2F8B3563"]);
      expect(logicalIds(template, "AWS::Events::Rule")).toEqual(["Failuresrule712D9F28"]);
    });

    it("builds an unversioned, retained failure bucket with the failure lifecycle", () => {
      template.hasResource("AWS::S3::Bucket", {
        Properties: {
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
            ],
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          LoggingConfiguration: Match.objectLike({ LogFilePrefix: "logs/" }),
          VersioningConfiguration: Match.absent(),
          LifecycleConfiguration: {
            Rules: [
              {
                Id: "AbortIncompleteMultipartUploadAfter7Days",
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
                Status: "Enabled",
              },
              { Id: "ExpireFailuresAfter90Days", ExpirationInDays: 90, Status: "Enabled" },
            ],
          },
        },
        DeletionPolicy: "Retain",
      });
    });

    it("switches EventBridge on through CDK's notifications handler", () => {
      template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: { EventBridgeConfiguration: {} },
      });
    });

    it("builds the signal queue in the dlq role with a 1-minute visibility timeout", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        MessageRetentionPeriod: 1_209_600,
        VisibilityTimeout: 60,
        SqsManagedSseEnabled: true,
      });
    });

    it("routes the bucket's Object Created events to the queue", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          source: ["aws.s3"],
          "detail-type": ["Object Created"],
          detail: { bucket: { name: [{ Ref: "Failuresbucket5560B8FC" }] } },
        },
        Targets: [Match.objectLike({ Arn: { "Fn::GetAtt": ["Failuresqueue2F8B3563", "Arn"] } })],
      });
      template.hasResourceProperties("AWS::SQS::QueuePolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["sqs:SendMessage"]),
              Principal: { Service: "events.amazonaws.com" },
              Condition: {
                ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": ["Failuresrule712D9F28", "Arn"] } },
              },
            }),
          ]),
        },
      });
    });

    it("alarms on any rule invocation that fails", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "FailedInvocations",
        Threshold: 0,
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
    });

    it("creates its own three alarms, and none from the component builders", () => {
      expect(Object.keys(result.alarms).sort()).toEqual([
        "failuresAgeing",
        "failuresWaiting",
        "signalUndelivered",
      ]);
      expect(result.bucket.alarms).toEqual({});
      expect(result.queue.alarms).toEqual({});
      expect(result.rule.alarms).toEqual({});
      template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    });

    it("alarms on any visible message, and on a message at 75% of retention", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateNumberOfMessagesVisible",
        Threshold: 0,
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateAgeOfOldestMessage",
        Threshold: 907_200,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });
  });

  describe("customisation", () => {
    it("passes each component's builder to its callback", () => {
      const { template } = synth(
        createStreamDlqCaptureBuilder()
          .bucket((b) => b.serverAccessLogs(false))
          .queue((q) => q.visibilityTimeout(Duration.minutes(5)))
          .rule((r) => r.description("Orders failures")),
      );
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.hasResourceProperties("AWS::SQS::Queue", { VisibilityTimeout: 300 });
      template.hasResourceProperties("AWS::Events::Rule", { Description: "Orders failures" });
    });

    it("scales the age alarm to a customised retention", () => {
      const result = build(
        createStreamDlqCaptureBuilder().queue((q) => q.retentionPeriod(Duration.days(7))),
      );
      expect(result.alarms.failuresAgeing.node.defaultChild).toMatchObject({ threshold: 453_600 });
    });

    it("merges the consumer's alarm config with capture's, field by field", () => {
      const result = build(
        createStreamDlqCaptureBuilder().recommendedAlarms({
          failuresWaiting: false,
          failuresAgeing: false,
          signalUndelivered: { threshold: 2 },
        }),
      );
      expect(Object.keys(result.alarms)).toEqual(["signalUndelivered"]);
      expect(result.alarms.signalUndelivered.node.defaultChild).toMatchObject({
        threshold: 2,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
      });
    });

    it.each([false, { enabled: false }] as const)(
      "turns every alarm off with %o",
      (recommendedAlarms) => {
        const { result, template } = synth(
          createStreamDlqCaptureBuilder().recommendedAlarms(recommendedAlarms),
        );
        expect(result.alarms).toEqual({});
        template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
      },
    );

    it("keeps an alarm a component callback adds beside capture's", () => {
      const result = build(
        createStreamDlqCaptureBuilder().queue((q) =>
          q.addAlarm("inFlight", (alarm) =>
            alarm
              .metric((queue) => queue.metricApproximateNumberOfMessagesNotVisible())
              .threshold(10)
              .greaterThan(),
          ),
        ),
      );
      expect(Object.keys(result.queue.alarms)).toEqual(["inFlight"]);
      expect(Object.keys(result.alarms)).toHaveLength(3);
    });

    it("takes SQS's 4-day retention for a queue that sets none", () => {
      const result = build(
        createStreamDlqCaptureBuilder().queue((q) => q.retentionPeriod(undefined)),
      );
      expect(result.alarms.failuresAgeing.node.defaultChild).toMatchObject({ threshold: 259_200 });
    });

    describe("with a token retention", () => {
      function tokenRetention(builder: IStreamDlqCaptureBuilder) {
        const stack = new Stack(new App(), "Test");
        const retention = new CfnParameter(stack, "Retention", { type: "Number" });
        const result = builder
          .queue((q) => q.retentionPeriod(Duration.seconds(retention.valueAsNumber)))
          .build(stack, "Failures");
        return { result, warnings: Annotations.fromStack(stack) };
      }

      it("skips the age alarm and the lifetime check, with warnings", () => {
        const { result, warnings } = tokenRetention(createStreamDlqCaptureBuilder());
        expect(Object.keys(result.alarms).sort()).toEqual(["failuresWaiting", "signalUndelivered"]);
        warnings.hasWarning("*", Match.stringLikeRegexp("stream failure ageing"));
        warnings.hasWarning("*", Match.stringLikeRegexp("can't check that the failure bucket"));
      });

      it("creates the age alarm when the consumer sets its threshold", () => {
        const { result } = tokenRetention(
          createStreamDlqCaptureBuilder().recommendedAlarms({
            failuresAgeing: { threshold: 3_600 },
          }),
        );
        expect(result.alarms.failuresAgeing.node.defaultChild).toMatchObject({ threshold: 3_600 });
      });
    });

    it("tags every resource it creates", () => {
      const { template } = synth(createStreamDlqCaptureBuilder().tag("Team", "orders"));
      const team = Match.arrayWith([{ Key: "Team", Value: "orders" }]);
      template.allResourcesProperties("AWS::S3::Bucket", { Tags: team });
      template.hasResourceProperties("AWS::SQS::Queue", { Tags: team });
      template.allResourcesProperties("AWS::CloudWatch::Alarm", { Tags: team });
    });

    it("keeps EventBridge on, whatever the bucket callback sets", () => {
      synth(
        createStreamDlqCaptureBuilder().bucket((b) => b.eventBridgeEnabled(false)),
      ).template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: { EventBridgeConfiguration: {} },
      });
    });

    it("copies its configuration independently", () => {
      assertCopyPreservesState({
        factory: () => createStreamDlqCaptureBuilder(),
        configure: (b) => b.bucket((bucket) => bucket.serverAccessLogs(false)),
        mutate: (b) => b.recommendedAlarms(false),
        build: (b) => build(b),
        inspect: (r) => ({
          accessLogs: r.bucket.accessLogsBucket !== undefined,
          alarms: Object.keys(r.alarms),
        }),
      });
    });
  });

  describe("lifetime guard", () => {
    it("rejects an expiry that doesn't outlast the queue's retention", () => {
      expect(() =>
        build(
          createStreamDlqCaptureBuilder().bucket((b) =>
            b.lifecycleRules([{ id: "Short", expiration: Duration.days(14) }]),
          ),
        ),
      ).toThrow(/"Short" expires objects after 14 days.*retention \(14 days\)/);
    });

    it("compares against a customised retention", () => {
      const withExpiry = (days: number) =>
        createStreamDlqCaptureBuilder()
          .bucket((b) => b.lifecycleRules([{ expiration: Duration.days(days) }]))
          .queue((q) => q.retentionPeriod(Duration.days(7)));
      expect(() => build(withExpiry(7))).toThrow(/"\(unnamed\)" expires objects after 7 days/);
      expect(() => build(withExpiry(8))).not.toThrow();
    });

    it("checks a replacement builder that a callback returns", () => {
      const replaced = (expiration: Duration) =>
        createStreamDlqCaptureBuilder()
          .bucket(() => createBucketBuilder().lifecycleRules([{ id: "Replaced", expiration }]))
          .queue(() => createQueueBuilder("dlq"));
      expect(() => build(replaced(Duration.days(14)))).toThrow(/"Replaced".*retention \(14 days\)/);
    });

    it("passes a bucket with no lifecycle rules", () => {
      expect(() =>
        build(createStreamDlqCaptureBuilder().bucket((b) => b.lifecycleRules([]))),
      ).not.toThrow();
    });

    it("ignores disabled rules and rules without an expiry", () => {
      expect(() =>
        build(
          createStreamDlqCaptureBuilder().bucket((b) =>
            b.lifecycleRules([
              { enabled: false, expiration: Duration.days(1) },
              { abortIncompleteMultipartUploadAfter: Duration.days(1) },
            ]),
          ),
        ),
      ).not.toThrow();
    });
  });

  it("nests in a composed system", () => {
    const stack = new Stack(new App(), "Test");
    const { failures } = compose(
      { failures: createStreamDlqCaptureBuilder() },
      { failures: [] },
    ).build(stack, "App");
    expect(failures.bucket.bucket.node.path).toBe("Test/App--failures--bucket");
  });
});
