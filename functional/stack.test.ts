import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { cleanDeskPolicy } from "./clean-desk-policy.ts";
import { deployTestStack, OUTPUTS } from "./stack.ts";

describe("the deploy test stack", () => {
  const app = new App();
  cleanDeskPolicy(app);
  const template = Template.fromStack(deployTestStack(app));

  it("outputs everything run.ts reads", () => {
    for (const key of OUTPUTS) template.hasOutput(key, {});
  });

  it("leaves nothing behind on delete", () => {
    for (const type of [
      "AWS::S3::Bucket",
      "AWS::Logs::LogGroup",
      "AWS::DynamoDB::GlobalTable",
      "AWS::KMS::Key",
    ]) {
      template.allResources(type, { DeletionPolicy: "Delete" });
    }
    template.allResourcesProperties("AWS::DynamoDB::GlobalTable", {
      Replicas: Match.arrayWith([Match.objectLike({ DeletionProtectionEnabled: false })]),
    });
  });

  it("creates one key, with the shortest deletion waiting period", () => {
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 7 });
  });

  it("gives every function a log group in the stack", () => {
    template.allResourcesProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: Match.anyValue() },
    });
  });
});
