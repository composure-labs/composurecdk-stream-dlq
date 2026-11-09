import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, StreamViewType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Stream, StreamConsumer } from "aws-cdk-lib/aws-kinesis";
import { Code, type IEventSource, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import {
  KinesisConsumerEventSource,
  KinesisEventSource,
} from "aws-cdk-lib/aws-lambda-event-sources";
import { BucketEncryption } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { compose, isRef, ref, type Resolvable } from "@composurecdk/core";
import {
  type ComposureEventSource,
  createFunctionBuilder,
  dynamoEventSource,
} from "@composurecdk/lambda";
import {
  createStreamDlqCaptureBuilder,
  type IStreamDlqCaptureBuilder,
  s3OnFailure,
  type StreamDlqCaptureResult,
} from "../src/index.js";

/** A stream event source in `stack`, with capture (`failures`) as its on-failure destination. */
type StreamSource = (stack: Stack) => Resolvable<ComposureEventSource | IEventSource>;

const failures = ref<StreamDlqCaptureResult>("failures");

const kinesisProps = (capture: StreamDlqCaptureResult) => ({
  startingPosition: StartingPosition.TRIM_HORIZON,
  retryAttempts: 1,
  onFailure: s3OnFailure(capture),
});

// CDK's own Kinesis sources, which ComposureCDK's kinesisEventSource and
// kinesisConsumerEventSource wrap, so this runs at the @composurecdk/lambda
// floor too. functional/ covers ComposureCDK's factories.
const SOURCES: Record<string, StreamSource> = {
  "a DynamoDB stream": (stack) =>
    dynamoEventSource(
      new TableV2(stack, "Orders", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
        dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      }),
      { retryAttempts: 1, onFailure: s3OnFailure(failures) },
    ),
  "a Kinesis stream": (stack) => {
    const stream = new Stream(stack, "Events");
    return failures.map((capture) => new KinesisEventSource(stream, kinesisProps(capture)));
  },
  "a Kinesis enhanced fan-out consumer": (stack) => {
    const consumer = new StreamConsumer(stack, "Consumer", {
      stream: new Stream(stack, "Events"),
      streamConsumerName: "processor",
    });
    return failures.map(
      (capture) => new KinesisConsumerEventSource(consumer, kinesisProps(capture)),
    );
  },
};

/** A processor reading `source`, with capture as its on-failure destination. */
function synth(
  source: StreamSource,
  capture: IStreamDlqCaptureBuilder = createStreamDlqCaptureBuilder(),
): Template {
  const stack = new Stack(new App(), "Test");
  compose(
    {
      failures: capture,
      processor: createFunctionBuilder()
        .runtime(Runtime.NODEJS_22_X)
        .handler("index.handler")
        .code(Code.fromInline("exports.handler = async () => {};"))
        .addEventSource("stream", source(stack)),
    },
    { failures: [], processor: ["failures"] },
  ).build(stack, "App");
  return Template.fromStack(stack);
}

interface PolicyResource {
  Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } };
}

/** Every action granted to the processor's role. */
function processorActions(template: Template): string[] {
  return Object.entries(template.findResources("AWS::IAM::Policy"))
    .filter(([logicalId]) => logicalId.includes("processor"))
    .flatMap(([, policy]) => (policy as PolicyResource).Properties.PolicyDocument.Statement)
    .flatMap((statement) => statement.Action)
    .sort();
}

const BUCKET = Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("failures"), "Arn"] });

describe.each(Object.entries(SOURCES))("s3OnFailure on %s", (_, source) => {
  const template = synth(source);

  it("names the failure bucket as the mapping's on-failure destination", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      DestinationConfig: { OnFailure: { Destination: BUCKET } },
    });
  });

  it("grants only s3:ListBucket on the bucket and s3:PutObject on its objects", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "s3:ListBucket", Resource: BUCKET }),
          Match.objectLike({
            Action: "s3:PutObject",
            Resource: { "Fn::Join": ["", [BUCKET, "/*"]] },
          }),
        ]),
      },
    });
    expect(processorActions(template).filter((action) => action.startsWith("s3:"))).toEqual([
      "s3:ListBucket",
      "s3:PutObject",
    ]);
  });

  it("adds kms:GenerateDataKey when the bucket has a customer-managed key", () => {
    const actions = processorActions(
      synth(
        source,
        createStreamDlqCaptureBuilder().bucket((b) => b.encryption(BucketEncryption.KMS)),
      ),
    );
    expect(actions.filter((action) => action.startsWith("kms:"))).toEqual(["kms:GenerateDataKey"]);
  });
});

describe("s3OnFailure", () => {
  it("takes a built capture result as well as a ref", () => {
    const capture = createStreamDlqCaptureBuilder().build(
      new Stack(new App(), "Built"),
      "Failures",
    );
    expect(isRef(s3OnFailure(capture))).toBe(false);
  });
});
