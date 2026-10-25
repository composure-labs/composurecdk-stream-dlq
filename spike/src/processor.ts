/**
 * The spike's stream processor. `MODE` switches its behaviour, so one deployed
 * function covers every scenario; the runner flips it with
 * UpdateFunctionConfiguration between steps.
 *
 * - `throw`: fail every batch (an invocation with `FunctionError` set).
 * - `partial`: report every record in `batchItemFailures`.
 * - `sleep:<seconds>`: wait, then succeed.
 * - `succeed`: succeed.
 *
 * Serialised with `.toString()` into `Code.fromInline` (ADR-0016), so it must
 * not reference anything outside its own body.
 */
export async function processor(event: {
  Records?: { dynamodb?: { Keys?: { pk?: { S?: string } }; SequenceNumber?: string } }[];
}): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const mode = process.env.MODE ?? "succeed";
  const records = event.Records ?? [];
  const pks = records.map((r) => r.dynamodb?.Keys?.pk?.S ?? "");
  console.log(JSON.stringify({ marker: "SPIKE_INVOKE", mode, pks, event }));

  if (mode === "throw") {
    throw new Error("spike: MODE=throw");
  }
  if (mode === "partial") {
    return {
      batchItemFailures: records.map((r) => ({ itemIdentifier: r.dynamodb?.SequenceNumber ?? "" })),
    };
  }
  if (mode.startsWith("sleep:")) {
    const seconds = Number(mode.slice("sleep:".length));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  return { batchItemFailures: [] };
}
