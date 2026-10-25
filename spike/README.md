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
