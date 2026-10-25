import { Duration } from "aws-cdk-lib";
import type { LifecycleRule } from "aws-cdk-lib/aws-s3";

/**
 * Lifecycle rules for the failure bucket. They replace composureCDK's bucket
 * defaults, whose noncurrent-version rule has nothing to act on with
 * versioning off.
 *
 * - Failure objects expire after 90 days. That must stay longer than the signal
 *   queue's retention, which the capture builder checks at build.
 * - Incomplete multipart uploads are aborted after 7 days, copied from
 *   composureCDK's bucket defaults, which don't export the rule on its own.
 */
export const DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES: LifecycleRule[] = [
  {
    id: "AbortIncompleteMultipartUploadAfter7Days",
    abortIncompleteMultipartUploadAfter: Duration.days(7),
  },
  {
    id: "ExpireFailuresAfter90Days",
    expiration: Duration.days(90),
  },
];

/**
 * Visibility timeout for the signal queue: 1 minute, so a message that a
 * crashed or failed consumer received becomes visible again promptly.
 */
export const DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT = Duration.minutes(1);
