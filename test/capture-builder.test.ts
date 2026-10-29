import { App, CfnParameter, CfnResource, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type { CfnRule } from "aws-cdk-lib/aws-events";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Key } from "aws-cdk-lib/aws-kms";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
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

function synth(
  builder: IStreamDlqCaptureBuilder = createStreamDlqCaptureBuilder(),
  props?: StackProps,
): {
  result: StreamDlqCaptureResult;
  template: Template;
} {
  const stack = new Stack(new App(), "Test", props);
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
        "Failuresbucket60D558A4",
        "FailuresbucketAccessLogs621B1FEF",
      ]);
      expect(logicalIds(template, "AWS::SQS::Queue")).toEqual(["Failuresqueue2DDD92D3"]);
      expect(logicalIds(template, "AWS::Events::Rule")).toEqual(["FailuresruleC90CB086"]);
    });

    it("builds everything under one construct, apart from CDK's per-stack notifications handler", () => {
      const outside = Stack.of(result.bucket.bucket)
        .node.findAll()
        .filter((c) => CfnResource.isCfnResource(c))
        .map((c) => c.node.path)
        .filter((path) => !/^Test\/(Failures|BucketNotificationsHandler[^/]*)\//.test(path));
      expect(outside).toEqual([]);
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
          detail: { bucket: { name: [{ Ref: "Failuresbucket60D558A4" }] } },
        },
        Targets: [Match.objectLike({ Arn: { "Fn::GetAtt": ["Failuresqueue2DDD92D3", "Arn"] } })],
      });
      template.hasResourceProperties("AWS::SQS::QueuePolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sqs:SendMessage",
              Principal: { Service: "events.amazonaws.com" },
              Condition: {
                ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": ["FailuresruleC90CB086", "Arn"] } },
              },
            }),
          ]),
        },
      });
    });

    it("leaves the rule unnamed", () => {
      template.hasResourceProperties("AWS::Events::Rule", { Name: Match.absent() });
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

  describe("with a customer-managed queue key", () => {
    const env = { account: "123456789012", region: "eu-west-2" };
    const keyed = () =>
      createStreamDlqCaptureBuilder().queue((q) => q.encryption(QueueEncryption.KMS));
    const { result, template } = synth(keyed(), { env });
    const ruleName = (result.rule.rule.node.defaultChild as CfnRule).name ?? "";

    it("names the rule after its path", () => {
      expect(ruleName).toMatch(/^Test-Failures-[A-Z0-9]+-rule$/);
    });

    it("grants EventBridge the key for this rule only", () => {
      const [key] = Object.values(template.findResources("AWS::KMS::Key")) as {
        Properties: { KeyPolicy: { Statement: { Principal?: { Service?: string } }[] } };
      }[];
      const statements = key.Properties.KeyPolicy.Statement;
      expect(statements.filter((s) => s.Principal?.Service === "events.amazonaws.com")).toEqual([
        {
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: ["kms:GenerateDataKey", "kms:Decrypt"],
          Resource: "*",
          Condition: {
            ArnEquals: {
              "aws:SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    `:events:eu-west-2:123456789012:rule/${ruleName}`,
                  ],
                ],
              },
            },
            StringEquals: { "aws:SourceAccount": "123456789012" },
          },
        },
      ]);
    });

    it("keeps the queue policy scoped to the rule", () => {
      template.hasResourceProperties("AWS::SQS::QueuePolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sqs:SendMessage",
              Condition: { ArnEquals: { "aws:SourceArn": Match.anyValue() } },
            }),
          ]),
        },
      });
    });

    it("keeps a rule name the consumer sets", () => {
      const named = build(keyed().rule((r) => r.ruleName("orders-failures")));
      expect((named.rule.rule.node.defaultChild as CfnRule).name).toBe("orders-failures");
    });

    it("rejects a rule name it can't put in the key's policy", () => {
      const stack = new Stack(new App(), "Test");
      const name = new CfnParameter(stack, "RuleName").valueAsString;
      expect(() =>
        keyed()
          .rule((r) => r.ruleName(name))
          .build(stack, "Failures"),
      ).toThrow(/name is a token/);
    });

    it("warns with the statement to add when the key is imported", () => {
      const stack = new Stack(new App(), "Test", { env });
      const imported = Key.fromKeyArn(
        stack,
        "Imported",
        "arn:aws:kms:eu-west-2:123456789012:key/abc",
      );
      createStreamDlqCaptureBuilder()
        .queue((q) => q.encryption(QueueEncryption.KMS).encryptionMasterKey(imported))
        .build(stack, "Failures");
      Annotations.fromStack(stack).hasWarning("*", Match.stringLikeRegexp("the key is imported"));
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

  it("names its alarms after the capture, so two in one stack don't collide", () => {
    const stack = new Stack(new App(), "Test");
    for (const id of ["Orders", "Payments"]) createStreamDlqCaptureBuilder().build(stack, id);
    // The same id under another construct mustn't collide either.
    createStreamDlqCaptureBuilder().build(new Construct(stack, "Refunds"), "Orders");
    const names = Object.values(Template.fromStack(stack).findResources("AWS::CloudWatch::Alarm"))
      .map((alarm) => (alarm as { Properties: { AlarmName: string } }).Properties.AlarmName)
      .sort();
    expect(names).toEqual([
      "test/orders/failures-ageing",
      "test/orders/failures-waiting",
      "test/orders/signal-undelivered",
      "test/payments/failures-ageing",
      "test/payments/failures-waiting",
      "test/payments/signal-undelivered",
      "test/refunds/orders/failures-ageing",
      "test/refunds/orders/failures-waiting",
      "test/refunds/orders/signal-undelivered",
    ]);
  });

  it("nests in a composed system", () => {
    const stack = new Stack(new App(), "Test");
    const { failures } = compose(
      { failures: createStreamDlqCaptureBuilder() },
      { failures: [] },
    ).build(stack, "App");
    expect(failures.bucket.bucket.node.path).toBe("Test/App--failures/bucket");
  });
});
