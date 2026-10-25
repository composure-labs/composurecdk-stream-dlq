import { drain, failureReason } from "./drain.js";
import { processor } from "./processor.js";

/** The processor's inline source: the typed function, exported as the handler. */
export const PROCESSOR_HANDLER = `${processor.toString()}
exports.handler = processor;
`;

/**
 * The replay function's inline source. Only the SDK adapter is untyped and
 * untested; `drain` and `failureReason` are the unit-tested functions,
 * serialised as-is. The AWS SDK v3 ships in the Node.js 22 runtime.
 */
export const REPLAY_HANDLER = `const { S3Client, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  SQSClient,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

${failureReason.toString()}

${drain.toString()}

const s3 = new S3Client({});
const sqs = new SQSClient({});
const lambda = new LambdaClient({});

exports.handler = async (_event, context) => {
  const { BUCKET, QUEUE_URL, TARGET, TARGET_TIMEOUT_SECONDS } = process.env;
  const targetTimeoutMs = Number(TARGET_TIMEOUT_SECONDS) * 1000;
  const api = {
    async receive() {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      return (out.Messages ?? []).map((m) => ({ receiptHandle: m.ReceiptHandle, body: m.Body }));
    },
    async extendVisibility(receiptHandle) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: Number(TARGET_TIMEOUT_SECONDS) + 60,
        }),
      );
    },
    async releaseMessage(receiptHandle) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }),
      );
    },
    async deleteMessage(receiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }));
    },
    async getObject(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        return await out.Body.transformToString();
      } catch (error) {
        if (error.name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    },
    async invoke(payload) {
      const out = await lambda.send(
        new InvokeCommand({ FunctionName: TARGET, InvocationType: "RequestResponse", Payload: payload }),
      );
      return {
        functionError: out.FunctionError,
        payload: out.Payload ? Buffer.from(out.Payload).toString("utf8") : "",
      };
    },
    hasTime() {
      return context.getRemainingTimeInMillis() > targetTimeoutMs + 30000;
    },
  };
  const summary = await drain(api);
  console.log(JSON.stringify({ marker: "SPIKE_DRAIN", summary }));
  return summary;
};
`;
