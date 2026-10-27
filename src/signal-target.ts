import { Annotations, Stack } from "aws-cdk-lib";
import type { IRule, IRuleTarget, RuleTargetConfig } from "aws-cdk-lib/aws-events";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { Queue } from "aws-cdk-lib/aws-sqs";

/**
 * The signal rule's queue target: EventBridge may send to the queue, and use
 * its key if it has one, for this rule only. CDK's `SqsQueue` target grants a
 * keyed queue's key to every rule (architecture F14). `ruleName` is the rule's
 * literal name, required with a key: its policy can't reference the rule
 * without a dependency cycle.
 */
export function signalTarget(queue: Queue, ruleName?: string): IRuleTarget {
  return {
    bind(rule: IRule): RuleTargetConfig {
      queue.grant(
        new ServicePrincipal("events.amazonaws.com", {
          conditions: { ArnEquals: { "aws:SourceArn": rule.ruleArn } },
        }),
        "sqs:SendMessage",
      );
      const key = queue.encryptionMasterKey;
      if (key !== undefined && ruleName !== undefined) {
        const stack = Stack.of(rule);
        const statement = new PolicyStatement({
          principals: [new ServicePrincipal("events.amazonaws.com")],
          actions: ["kms:GenerateDataKey", "kms:Decrypt"],
          resources: ["*"],
          conditions: {
            ArnEquals: {
              "aws:SourceArn": stack.formatArn({
                service: "events",
                resource: "rule",
                resourceName: ruleName,
              }),
            },
            StringEquals: { "aws:SourceAccount": stack.account },
          },
        });
        if (!key.addToResourcePolicy(statement).statementAdded) {
          Annotations.of(queue).addWarningV2(
            "@composure-labs/composurecdk-stream-dlq:imported-queue-key",
            "Stream DLQ capture can't add EventBridge's statement to the signal queue's key, " +
              "because the key is imported. Without it no signal is delivered. Add this to the " +
              `key policy: ${JSON.stringify(stack.resolve(statement.toStatementJson()))}`,
          );
        }
      }
      return { arn: queue.queueArn, targetResource: queue };
    },
  };
}
