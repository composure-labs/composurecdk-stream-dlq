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
export { type StreamDlqCaptureAlarmConfig } from "./capture-alarms.js";
export {
  DEFAULT_CAPTURE_ALARM_PERIOD,
  DEFAULT_CAPTURE_ALARMS,
  DEFAULT_FAILURE_BUCKET_LIFECYCLE_RULES,
  DEFAULT_SIGNAL_QUEUE_AGE_ALARM_RATIO,
  DEFAULT_SIGNAL_QUEUE_RETENTION,
  DEFAULT_SIGNAL_QUEUE_VISIBILITY_TIMEOUT,
} from "./defaults.js";
