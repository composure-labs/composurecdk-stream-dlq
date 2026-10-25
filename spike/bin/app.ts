import { App, Duration } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { captureStack, QueueEncryption, signalOnlyStack, spikeKey } from "../src/stacks.js";

const app = new App();
// Scenario 1 redeploys Direct with `-c notifyPrefix=…` to change the notification.
const notifyPrefix = app.node.tryGetContext("notifyPrefix") as string | undefined;
// Scenario 6 synthesises Direct alone, under another name, on the floor aws-cdk-lib.
const floor = app.node.tryGetContext("floor") === "true";

const followUp = app.node.tryGetContext("followUp") === "true";

if (followUp) {
  // Follow-up 1: EventBridge without BucketNotificationsHandler, alone and beside a consumer notification.
  captureStack(app, "NoHandler", { signal: "eventbridge-native", replay: false });
  captureStack(app, "NoHandlerShared", {
    signal: "eventbridge-native",
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
