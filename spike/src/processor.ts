/**
 * The spike's stream processor. `MODE` switches its behaviour, so one deployed
 * function covers every scenario; the runner flips it with
 * UpdateFunctionConfiguration between steps.
 *
 * - `throw`: fail every batch (an invocation with `FunctionError` set).
 *   `throw:<suffix>` fails only a batch holding a record whose pk ends `<suffix>`.
 * - `partial`: report every record in `batchItemFailures`. `partial:<suffix>`
 *   reports only the records whose pk ends `<suffix>`.
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

  const [kind, arg = ""] = mode.split(":");
  const failing = records.filter((_, i) => (pks[i] ?? "").endsWith(arg));
  if (kind === "throw" && failing.length > 0) {
    throw new Error(`spike: MODE=${mode}`);
  }
  if (kind === "partial") {
    return {
      batchItemFailures: failing.map((r) => ({ itemIdentifier: r.dynamodb?.SequenceNumber ?? "" })),
    };
  }
  if (kind === "sleep") {
    await new Promise((resolve) => setTimeout(resolve, Number(arg) * 1000));
  }
  return { batchItemFailures: [] };
}
