# Spike: stream DLQ behaviour in a real account

Throwaway CDK app for [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623) §4. It is deleted once the findings are acted on; only scenario 5 survives, as the deploy test. Findings: see the spike comment on #623.

Run from this directory with sandbox credentials (`eu-west-2`):

```sh
npm ci && npx tsc -p . && node --test 'dist/test/*.test.js'
npx cdk deploy --all --require-approval never --concurrency 6
node dist/src/run.js s1 Direct <since-ms>   # test events, depth alarm
node dist/src/run.js s4 Direct              # failure object, re-invoke verbatim (also EventBridge)
node dist/src/run.js s3 EncCmk              # delivery to a CMK-encrypted queue
node dist/src/run.js s5                     # drain(): B1, release, B2 heartbeat
node dist/src/run.js concurrency            # a second drain against reserved concurrency 1
node dist/src/run.js age                    # age alarm on a 5-minute-retention queue
node dist/src/run.js inventory              # resources per stack, for the cost line
node dist/src/run.js teardown               # stacks, RETAIN buckets (every version), log groups
```

Scenario 6 copies this directory, installs `aws-cdk-lib@2.184.0`, and synthesises and deploys with `-c floor=true`. Results land in `results/`, which is not committed: it holds account IDs and ARNs.

## Open items: F14, F1, F5 and B

These answer the open items in `docs/architecture.md`, plus B: what batch bisection does to capture. They deploy as their own set with `-c openItems=true`, and run locally with your sandbox credentials, like the rest of the spike. They need `sqs:SetQueueAttributes` for F5, which the GitHub OIDC role does not grant.

```sh
npm ci && npx tsc -p .
npx cdk deploy --all -c openItems=true --require-approval never --concurrency 6
node dist/src/run.js f14 CmkCdk        # CDK's own key statement for EventBridge
node dist/src/run.js f14 CmkScoped     # the documented statement, scoped to the rule
node dist/src/run.js f14 CmkNoPolicy   # no statement: key policy drift (about 10 min)
node dist/src/run.js f1                # failure object write denied after deploy (about 19 min)
node dist/src/run.js f5 5              # queue denies EventBridge for 5 min, then restored (up to 37 min)
node dist/src/run.js bisect throw      # one poison record in 10; the processor errors (up to 20 min)
node dist/src/run.js bisect partial    # the same; the processor reports the record (up to 20 min)
node dist/src/run.js teardown
```

| Item | Stack               | What to look at in `results/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Result               |
| ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| F14  | `CmkCdk`            | `delivered`. CDK gives `events.amazonaws.com` `kms:Decrypt`, `Encrypt`, `ReEncrypt*` and `GenerateDataKey*` on the key with no condition, so this shows what capture would get by default                                                                                                                                                                                                                                                                                                                                     | Pending, not yet run |
| F14  | `CmkScoped`         | `delivered`: whether `aws:SourceArn` (the rule) and `aws:SourceAccount` are present when SQS calls KMS for EventBridge. The rule is named because a key policy that references the rule is a dependency cycle (key → rule → queue → key)                                                                                                                                                                                                                                                                                      | Pending, not yet run |
| F14  | `CmkNoPolicy`       | `delivered` should be false. `ruleFailedAlarmReachedAlarm` and `ruleMetrics.FailedInvocations` show whether drift surfaces as `FailedInvocations`                                                                                                                                                                                                                                                                                                                                                                             | Pending, not yet run |
| F1   | `DestinationDenied` | The bucket policy denies the processor's `PutObject` during the run: a deny in the template fails the mapping's creation (Lambda checks the role can write). `failureObjectWritten` should be false; `failureObjectWrittenAfterRestore` shows whether the write is retried once the deny is lifted. `esmMetrics.DroppedEventCount`, `alarmSamples` (the processor's `tableDroppedEvents` alarm), `functionMetrics.DestinationDeliveryFailures` and `mapping.lastProcessingResult` show what raises a failed destination write | Pending, not yet run |
| F5   | `SignalRetry`       | `delivered` and `secondsRestoreToMessage`: whether the default retry policy (185 attempts, 24 hours) retries a permission error. `ruleMetrics.RetryInvocationAttempts` and `FailedInvocations` show what EventBridge did                                                                                                                                                                                                                                                                                                      | Pending, not yet run |
| B    | `Bisect`            | `objectCount`, `goodRecordsStored` and `timesStored`: how many objects one poison record makes, and whether records that never failed reach the bucket. `invocations` shows the splits; `timesInvoked` above 1 for a good record means it ran again. `secondsToLastObject` is the time to capture under the defaults (bisect on, partial batch responses on, `retryAttempts: 2`)                                                                                                                                              | Pending, not yet run |

`f1` and `f5` restore the bucket and queue policies even when the run fails. If either process is killed while its deny is in place, redeploy `DestinationDenied` or `SignalRetry` to put the policy back. Record the outcomes in the spike comment on #623, and in the open items and the failure-mode table in `docs/architecture.md`. B also feeds the README's retry guidance and the replay design: duplicate or good records in the bucket mean replay must be idempotent.
