import { App, Duration } from "aws-cdk-lib";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  captureStack,
  cmkEventBridgeStack,
  QueueEncryption,
  signalOnlyStack,
  spikeKey,
} from "../src/stacks.js";

const app = new App();
// Scenario 1 redeploys Direct with `-c notifyPrefix=…` to change the notification.
const notifyPrefix = app.node.tryGetContext("notifyPrefix") as string | undefined;
// Scenario 6 synthesises Direct alone, under another name, on the floor aws-cdk-lib.
const floor = app.node.tryGetContext("floor") === "true";

const followUp = app.node.tryGetContext("followUp") === "true";
// The architecture doc's open items: F14, F1 and F5, and B (batch bisection).
const openItems = app.node.tryGetContext("openItems") === "true";

if (openItems) {
  cmkEventBridgeStack(app, "CmkCdk", "cdk");
  cmkEventBridgeStack(app, "CmkScoped", "scoped");
  cmkEventBridgeStack(app, "CmkNoPolicy", "none");
  captureStack(app, "DestinationDenied", {
    signal: "eventbridge",
    replay: false,
    denyDestinationWrite: true,
  });
  // Default retry policy (185 attempts over 24 hours), for F5's recovery window.
  captureStack(app, "SignalRetry", { signal: "eventbridge", replay: false });
  // B: composureCDK's stream defaults with bounded retries. The batching
  // window makes one BatchWriteItem arrive as one batch, and TRIM_HORIZON
  // keeps a run soon after deploy from missing its writes.
  captureStack(app, "Bisect", {
    signal: "eventbridge",
    replay: false,
    eventSource: {
      startingPosition: StartingPosition.TRIM_HORIZON,
      bisectBatchOnError: true,
      retryAttempts: 2,
      batchSize: 10,
      maxBatchingWindow: Duration.seconds(10),
    },
  });
} else if (followUp) {
  // Follow-up 1: EventBridge without BucketNotificationsHandler, alone and beside a consumer notification.
  captureStack(app, "NoHandler", { signal: "eventbridge-native", replay: false });
  captureStack(app, "NoHandlerShared", {
    signal: "eventbridge-native",
    replay: false,
    consumerNotification: true,
  });
  // Follow-up 3: the handler path (L2 eventBridgeEnabled) beside a consumer notification.
  captureStack(app, "HandlerShared", {
    signal: "eventbridge",
    replay: false,
    consumerNotification: true,
  });
  // Follow-up 2: a signal EventBridge cannot deliver.
  captureStack(app, "SignalFailure", { signal: "eventbridge", replay: false, denyDelivery: true });
} else if (floor) {
  captureStack(app, "Floor", { signal: "direct", replay: true });
} else {
  captureStack(app, "Direct", { signal: "direct", replay: true, notifyPrefix });
  captureStack(app, "EventBridge", { signal: "eventbridge", replay: false });

  // Scenario 3. The direct notification's SqsDestination adds S3's statement
  // to the queue key's policy, but only for a key it owns: an imported key
  // stands in for "a CMK without the statement".
  signalOnlyStack(app, "EncAwsManaged", (q) => q.encryption(QueueEncryption.KMS_MANAGED));
  signalOnlyStack(app, "EncCmk", (q, stack) =>
    q.encryption(QueueEncryption.KMS).encryptionMasterKey(spikeKey(stack)),
  );
  signalOnlyStack(app, "EncCmkNoPolicy", (q, stack) =>
    q
      .encryption(QueueEncryption.KMS)
      .encryptionMasterKey(Key.fromKeyArn(stack, "Imported", spikeKey(stack).keyArn)),
  );

  // Scenario 5's age alarm: 75% of a 5-minute retention is 225 seconds.
  signalOnlyStack(app, "ShortRetention", (q) => q.retentionPeriod(Duration.minutes(5)));
}

app.synth();
