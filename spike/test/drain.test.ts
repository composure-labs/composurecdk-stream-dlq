import assert from "node:assert/strict";
import { test } from "node:test";
import { drain, failureReason, type DrainApi, type InvokeResult } from "../src/drain.js";

function s3Event(key: string): string {
  return JSON.stringify({ Records: [{ s3: { object: { key } } }] });
}

/** An in-memory queue and bucket, with the target's response chosen per call. */
function fakeApi(bodies: string[], objects: Record<string, string>, results: InvokeResult[]) {
  const queue = bodies.map((body, i) => ({ receiptHandle: `rh${String(i)}`, body, hidden: false }));
  const calls: string[] = [];
  const api: DrainApi = {
    receive() {
      const next = queue.find((m) => !m.hidden);
      if (next) next.hidden = true;
      return Promise.resolve(next ? [next] : []);
    },
    extendVisibility(rh) {
      calls.push(`extend:${rh}`);
      return Promise.resolve();
    },
    releaseMessage(rh) {
      calls.push(`release:${rh}`);
      return Promise.resolve();
    },
    deleteMessage(rh) {
      calls.push(`deleteMessage:${rh}`);
      queue.splice(
        queue.findIndex((m) => m.receiptHandle === rh),
        1,
      );
      return Promise.resolve();
    },
    getObject(key) {
      return Promise.resolve(objects[key]);
    },
    deleteObject(key) {
      calls.push(`deleteObject:${key}`);
      return Promise.resolve();
    },
    invoke(payload) {
      calls.push(`invoke:${payload}`);
      return Promise.resolve(results.shift() ?? { payload: "null" });
    },
    hasTime: () => true,
  };
  return { api, calls, queue };
}

const failure = (payload: unknown) => JSON.stringify({ payload });

test("a 200 with batchItemFailures or FunctionError is not success (B1)", () => {
  assert.equal(failureReason({ payload: '{"batchItemFailures":[]}' }), undefined);
  assert.equal(failureReason({ payload: "null" }), undefined);
  assert.equal(
    failureReason({ payload: '{"batchItemFailures":[{"itemIdentifier":"1"}]}' }),
    "batchItemFailures: 1",
  );
  assert.equal(
    failureReason({ functionError: "Unhandled", payload: "{}" }),
    "FunctionError: Unhandled",
  );
});

test("replays, then deletes the object and the message", async () => {
  const { api, calls } = fakeApi([s3Event("a")], { a: failure({ Records: [] }) }, [
    { payload: '{"batchItemFailures":[]}' },
  ]);
  const summary = await drain(api);
  assert.deepEqual(summary.replayed, ["a"]);
  assert.deepEqual(calls, [
    "extend:rh0",
    'invoke:{"Records":[]}',
    "deleteObject:a",
    "deleteMessage:rh0",
  ]);
});

test("keeps the object on a partial failure and releases the message at the end", async () => {
  const { api, calls } = fakeApi([s3Event("a")], { a: failure("{}") }, [
    { payload: '{"batchItemFailures":[{"itemIdentifier":"1"}]}' },
  ]);
  const summary = await drain(api);
  assert.deepEqual(summary.kept, [{ key: "a", reason: "batchItemFailures: 1" }]);
  assert.ok(!calls.some((c) => c.startsWith("delete")));
  assert.equal(calls.at(-1), "release:rh0");
});

test("discards S3 test events and decodes keys", async () => {
  const { api, calls } = fakeApi(
    [JSON.stringify({ Event: "s3:TestEvent" }), s3Event("a+b%3Dc")],
    { "a b=c": failure("{}") },
    [],
  );
  const summary = await drain(api);
  assert.equal(summary.testEvents, 1);
  assert.deepEqual(summary.replayed, ["a b=c"]);
  assert.ok(calls.includes("deleteMessage:rh0"));
});

test("reads EventBridge's message shape", async () => {
  const body = JSON.stringify({
    "detail-type": "Object Created",
    detail: { object: { key: "a" } },
  });
  const { api } = fakeApi([body], { a: failure("{}") }, []);
  assert.deepEqual((await drain(api)).replayed, ["a"]);
});

test("treats a missing object as already replayed", async () => {
  const { api, queue } = fakeApi([s3Event("gone")], {}, []);
  const summary = await drain(api);
  assert.deepEqual(summary.alreadyGone, ["gone"]);
  assert.equal(queue.length, 0);
});
