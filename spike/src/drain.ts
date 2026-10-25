/**
 * Prototype of the replay function's `drain()` (plan §3), written against an
 * injected API so it is unit-tested without AWS (ADR-0016's shape). Both
 * functions are serialised with `.toString()`, so neither may reference
 * anything outside its own body except the other.
 */

export interface DrainMessage {
  receiptHandle: string;
  body: string;
}

export interface InvokeResult {
  functionError?: string;
  payload: string;
}

export interface DrainApi {
  /** Receives at most one message. Empty when the queue has none visible. */
  receive(): Promise<DrainMessage[]>;
  /** B2's heartbeat: hide the message for the target's timeout plus a margin. */
  extendVisibility(receiptHandle: string): Promise<void>;
  /** Makes a kept message visible again, so a re-run after a fix sees it at once. */
  releaseMessage(receiptHandle: string): Promise<void>;
  deleteMessage(receiptHandle: string): Promise<void>;
  /** The object's body, or `undefined` if it no longer exists. */
  getObject(key: string): Promise<string | undefined>;
  deleteObject(key: string): Promise<void>;
  /** A synchronous (RequestResponse) invoke of the target. */
  invoke(payload: string): Promise<InvokeResult>;
  /** False once there isn't time for another target invoke. */
  hasTime(): boolean;
}

export interface DrainSummary {
  replayed: string[];
  kept: { key: string; reason: string }[];
  alreadyGone: string[];
  testEvents: number;
  unrecognised: string[];
}

/**
 * B1: why an invoke must not count as success, or `undefined` if it succeeded.
 * A 200 response is not success: a thrown error sets `FunctionError`, and a
 * processor using ReportBatchItemFailures reports failures in the body.
 */
export function failureReason(result: InvokeResult): string | undefined {
  if (result.functionError !== undefined) {
    return `FunctionError: ${result.functionError}`;
  }
  let body: unknown;
  try {
    body = JSON.parse(result.payload);
  } catch {
    return undefined;
  }
  if (typeof body === "object" && body !== null && "batchItemFailures" in body) {
    const failures = (body as { batchItemFailures: unknown }).batchItemFailures;
    if (Array.isArray(failures) && failures.length > 0) {
      return `batchItemFailures: ${String(failures.length)}`;
    }
  }
  return undefined;
}

export async function drain(api: DrainApi): Promise<DrainSummary> {
  const summary: DrainSummary = {
    replayed: [],
    kept: [],
    alreadyGone: [],
    testEvents: 0,
    unrecognised: [],
  };
  const released: string[] = [];

  while (api.hasTime()) {
    const [message] = await api.receive();
    if (message === undefined) {
      break;
    }
    await api.extendVisibility(message.receiptHandle);

    const body = JSON.parse(message.body) as {
      Event?: string;
      Records?: { s3?: { object?: { key?: string } } }[];
      "detail-type"?: string;
      detail?: { object?: { key?: string } };
    };
    if (body.Event === "s3:TestEvent") {
      summary.testEvents++;
      await api.deleteMessage(message.receiptHandle);
      continue;
    }

    let keys: string[] | undefined;
    if (Array.isArray(body.Records)) {
      // S3 notifications URL-encode the key, with "+" for a space.
      keys = body.Records.map((r) =>
        decodeURIComponent((r.s3?.object?.key ?? "").replace(/\+/g, " ")),
      );
    } else if (body["detail-type"] === "Object Created" && body.detail?.object?.key) {
      // EventBridge delivers the key decoded.
      keys = [body.detail.object.key];
    }
    if (keys === undefined) {
      summary.unrecognised.push(message.body);
      released.push(message.receiptHandle);
      continue;
    }

    let keep = false;
    for (const key of keys) {
      const object = await api.getObject(key);
      if (object === undefined) {
        summary.alreadyGone.push(key);
        continue;
      }
      const record = JSON.parse(object) as { payload?: unknown };
      const payload =
        typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload);
      const reason = failureReason(await api.invoke(payload));
      if (reason !== undefined) {
        summary.kept.push({ key, reason });
        keep = true;
        continue;
      }
      await api.deleteObject(key);
      summary.replayed.push(key);
    }

    if (keep) {
      released.push(message.receiptHandle);
    } else {
      await api.deleteMessage(message.receiptHandle);
    }
  }

  // Released only now: releasing inside the loop would receive them again.
  for (const receiptHandle of released) {
    await api.releaseMessage(receiptHandle);
  }
  return summary;
}
