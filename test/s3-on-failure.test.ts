import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, StreamViewType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { BucketEncryption } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { compose, isRef, ref } from "@composurecdk/core";
import { createFunctionBuilder, dynamoEventSource } from "@composurecdk/lambda";
import {
  createStreamDlqCaptureBuilder,
  type IStreamDlqCaptureBuilder,
  s3OnFailure,
} from "../src/index.js";

/** A processor reading a table's stream, with capture as its on-failure destination. */
function synth(failures: IStreamDlqCaptureBuilder = createStreamDlqCaptureBuilder()): Template {
  const stack = new Stack(new App(), "Test");
  const table = new TableV2(stack, "Orders", {
    partitionKey: { name: "pk", type: AttributeType.STRING },
    dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
  });
  compose(
    {
      failures,
      processor: createFunctionBuilder()
        .runtime(Runtime.NODEJS_22_X)
        .handler("index.handler")
        .code(Code.fromInline("exports.handler = async () => {};"))
        .addEventSource(
          "orders",
          dynamoEventSource(table, {
            retryAttempts: 1,
            onFailure: s3OnFailure(ref("failures")),
          }),
        ),
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

describe("s3OnFailure", () => {
  const template = synth();

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
      synth(createStreamDlqCaptureBuilder().bucket((b) => b.encryption(BucketEncryption.KMS))),
    );
    expect(actions.filter((action) => action.startsWith("kms:"))).toEqual(["kms:GenerateDataKey"]);
  });

  it("takes a built capture result as well as a ref", () => {
    const capture = createStreamDlqCaptureBuilder().build(
      new Stack(new App(), "Built"),
      "Failures",
    );
    expect(isRef(s3OnFailure(capture))).toBe(false);
  });
});
