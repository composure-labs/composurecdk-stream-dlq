import { Grant } from "aws-cdk-lib/aws-iam";
import type {
  DlqDestinationConfig,
  IEventSourceDlq,
  IEventSourceMapping,
  IFunction,
} from "aws-cdk-lib/aws-lambda";
import { isRef, type Resolvable } from "@composurecdk/core";
import type { StreamDlqCaptureResult } from "./capture-builder.js";

/**
 * The on-failure destination for an event source mapping: capture's failure
 * bucket, with only the permissions Lambda needs to write a failure to it.
 *
 * Pass it as a stream event source's `onFailure`. CDK's
 * `S3OnFailureDestination` grants the processor read and write on the bucket,
 * so the processor could read or delete every captured failure. This grants
 * `s3:PutObject` on the bucket's objects and `s3:ListBucket` on the bucket,
 * which is what Lambda documents for an S3 destination, plus
 * `kms:GenerateDataKey` when the bucket has a customer-managed key
 * (architecture D8).
 *
 * @param capture - The capture builder's result, usually `ref("failures")`.
 *
 * @example
 * ```ts
 * dynamoEventSource(ref("orders", (r) => r.table), {
 *   retryAttempts: 3,
 *   onFailure: s3OnFailure(ref("failures")),
 * });
 * ```
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html
 */
export function s3OnFailure(
  capture: Resolvable<StreamDlqCaptureResult>,
): Resolvable<IEventSourceDlq> {
  return isRef(capture) ? capture.map(toDestination) : toDestination(capture);
}

function toDestination({ bucket: { bucket } }: StreamDlqCaptureResult): IEventSourceDlq {
  return {
    bind(_target: IEventSourceMapping, handler: IFunction): DlqDestinationConfig {
      // Two statements: each action applies to its own resource.
      Grant.addToPrincipal({
        grantee: handler,
        actions: ["s3:ListBucket"],
        resourceArns: [bucket.bucketArn],
      });
      Grant.addToPrincipal({
        grantee: handler,
        actions: ["s3:PutObject"],
        resourceArns: [bucket.arnForObjects("*")],
      });
      bucket.encryptionKey?.grant(handler, "kms:GenerateDataKey");
      return { destination: bucket.bucketArn };
    },
  };
}
