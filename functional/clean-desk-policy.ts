// A trimmed copy of composureCDK's `cleanDeskPolicy`
// (packages/examples/src/clean-desk-policy.ts), keeping the parts this stack
// needs. Raise any extension as a PR on both copies.
import {
  Aspects,
  CfnDeletionPolicy,
  CfnResource,
  Duration,
  type IAspect,
  type IPropertyInjector,
  PropertyInjectors,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import { TableV2, type TablePropsV2 } from "aws-cdk-lib/aws-dynamodb";
import { Key, type KeyProps } from "aws-cdk-lib/aws-kms";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, type LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket, type BucketProps, CfnBucket } from "aws-cdk-lib/aws-s3";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { IConstruct } from "constructs";

/** Destroys log groups with the stack. */
class LogGroupRemovalPolicyInjector implements IPropertyInjector {
  readonly constructUniqueId = LogGroup.PROPERTY_INJECTION_ID;

  inject(originalProps: LogGroupProps): LogGroupProps {
    return { ...originalProps, removalPolicy: RemovalPolicy.DESTROY };
  }
}

/**
 * Destroys buckets with the stack, emptying them first. This overrides
 * capture's RETAIN on the failure bucket, which is right for real data and
 * wrong for a test.
 */
class BucketRemovalPolicyInjector implements IPropertyInjector {
  readonly constructUniqueId = Bucket.PROPERTY_INJECTION_ID;

  inject(originalProps: BucketProps): BucketProps {
    return { ...originalProps, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true };
  }
}

/** Destroys `TableV2` tables with the stack, clearing deletion protection. */
class TableV2RemovalPolicyInjector implements IPropertyInjector {
  readonly constructUniqueId = TableV2.PROPERTY_INJECTION_ID;

  inject(originalProps: TablePropsV2): TablePropsV2 {
    return { ...originalProps, removalPolicy: RemovalPolicy.DESTROY, deletionProtection: false };
  }
}

/**
 * Destroys KMS keys with the stack, after the shortest waiting period KMS
 * allows (7 days). A key is billed hourly until it is scheduled for deletion,
 * and not while it waits, so a test's key costs only the hours its stack
 * exists. `@composurecdk/kms` defaults to RETAIN, which would leave a key
 * billing every month after each run.
 */
class KeyRemovalPolicyInjector implements IPropertyInjector {
  readonly constructUniqueId = Key.PROPERTY_INJECTION_ID;

  inject(originalProps: KeyProps): KeyProps {
    return {
      ...originalProps,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    };
  }
}

const DISABLE_LOGGING_CR_ID = "CleanDeskDisableLogging";

/** Recognises an S3 bucket L2 by its L1's resource type, not `instanceof` (ADR-0007, ADR-0011). */
function asBucket(node: IConstruct): Bucket | undefined {
  const l1 = node.node.defaultChild;
  if (!CfnResource.isCfnResource(l1)) return undefined;
  if (l1.cfnResourceType !== CfnBucket.CFN_RESOURCE_TYPE_NAME) return undefined;
  return node as Bucket;
}

/**
 * Switches a deleted bucket's server access logging off before it is emptied,
 * so access-log records of its own deletion can't land in the logs bucket
 * after that has been emptied (a 409 BucketNotEmpty on teardown). Capture's
 * failure bucket logs to its own logs bucket, so this applies.
 */
class DisableSourceLoggingOnDeleteAspect implements IAspect {
  visit(node: IConstruct): void {
    const bucket = asBucket(node);
    if (!bucket) return;

    const cfn = bucket.node.defaultChild as CfnBucket;
    if (cfn.cfnOptions.deletionPolicy !== CfnDeletionPolicy.DELETE) return;

    const logging = cfn.loggingConfiguration as CfnBucket.LoggingConfigurationProperty | undefined;
    if (!logging?.destinationBucketName) return;
    if (!resolveLogsBucketInStack(bucket, logging.destinationBucketName)) return;
    if (bucket.node.tryFindChild(DISABLE_LOGGING_CR_ID)) return;

    const disableLogging = new AwsCustomResource(bucket, DISABLE_LOGGING_CR_ID, {
      resourceType: "Custom::DisableBucketLogging",
      onDelete: {
        service: "S3",
        action: "putBucketLogging",
        parameters: { Bucket: bucket.bucketName, BucketLoggingStatus: {} },
        physicalResourceId: PhysicalResourceId.of(`${bucket.node.addr}-disable-logging`),
        ignoreErrorCodesMatching: "NoSuchBucket",
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [bucket.bucketArn] }),
      installLatestAwsSdk: false,
    });

    // Delete order: switch logging off before the source bucket is emptied.
    const sourceAutoDelete = bucket.node.tryFindChild("AutoDeleteObjectsCustomResource");
    if (sourceAutoDelete) disableLogging.node.addDependency(sourceAutoDelete);
  }
}

/** The in-stack bucket a logging destination's `Ref` resolves to, if any. */
function resolveLogsBucketInStack(source: Bucket, destinationBucketName: unknown): boolean {
  const stack = Stack.of(source);
  const destination = JSON.stringify(stack.resolve(destinationBucketName));
  return stack.node.findAll().some((candidate) => {
    const bucket = asBucket(candidate);
    return (
      bucket !== undefined &&
      bucket !== source &&
      JSON.stringify(stack.resolve(bucket.bucketName)) === destination
    );
  });
}

const FUNCTION_LOG_GROUP_ID = "CleanDeskLogGroup";

/**
 * Gives every Lambda function without a log group of its own one in the
 * stack, so CDK's helper functions (the S3 notifications handler, the
 * auto-delete provider, the custom resource above) don't leave
 * `/aws/lambda/*` groups behind.
 */
class FunctionLogGroupAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!CfnFunction.isCfnFunction(node)) return;
    // Undefined on a raw `CfnResource`, which exposes no typed properties.
    const existing = (node as Partial<CfnFunction>).loggingConfig as
      CfnFunction.LoggingConfigProperty | undefined;
    if (existing?.logGroup) return;

    const scope = node.node.scope;
    if (!scope || scope.node.tryFindChild(FUNCTION_LOG_GROUP_ID)) return;

    const logGroup = new LogGroup(scope, FUNCTION_LOG_GROUP_ID, {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    node.addPropertyOverride("LoggingConfig.LogGroup", logGroup.logGroupName);
  }
}

/**
 * Makes everything under `scope` deletable with its stack. For the deploy
 * test only: **never use it on a real capture**, whose failure bucket must be
 * retained.
 */
export function cleanDeskPolicy(scope: IConstruct): void {
  const injectors = PropertyInjectors.of(scope);
  injectors.add(new BucketRemovalPolicyInjector());
  injectors.add(new LogGroupRemovalPolicyInjector());
  injectors.add(new TableV2RemovalPolicyInjector());
  injectors.add(new KeyRemovalPolicyInjector());

  Aspects.of(scope).add(new DisableSourceLoggingOnDeleteAspect());
  Aspects.of(scope).add(new FunctionLogGroupAspect());
}
