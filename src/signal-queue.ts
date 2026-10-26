import type { CfnQueue, Queue } from "aws-cdk-lib/aws-sqs";

/** SQS's retention when none is set: 4 days. */
const SQS_DEFAULT_RETENTION_SECONDS = 345_600;

/**
 * The signal queue's retention in seconds, read from the L1 so it is what will
 * deploy, whichever builder made the queue. May be an unresolved token, for
 * example when retention comes from a `CfnParameter`.
 */
export function signalQueueRetentionSeconds(queue: Queue): number {
  return (
    (queue.node.defaultChild as CfnQueue).messageRetentionPeriod ?? SQS_DEFAULT_RETENTION_SECONDS
  );
}
