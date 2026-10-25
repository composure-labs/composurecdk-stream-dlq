/**
 * `@composure-labs/composurecdk-stream-dlq` — no-loss failure capture for
 * Lambda stream consumers, built on composureCDK.
 */
export {
  createStreamDlqCaptureBuilder,
  type IStreamDlqCaptureBuilder,
  type StreamDlqCaptureBuilderProps,
  type StreamDlqCaptureResult,
} from "./capture-builder.js";
export {
  DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES,
  DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT,
} from "./defaults.js";
