# Deploy test

Deploys the README's getting-started example to the sandbox account, built from this package's `dist/` as a consumer would build it, and drives one failure through it:

1. Waits for the processor's event source mapping to be `Enabled`.
2. Writes a record. The processor fails every batch, with no retries.
3. Waits for the failed batch to land in the failure bucket.
4. Waits for capture's `failuresWaiting` alarm to fire.
5. Receives the signal for that object, then deletes it, as an operator would once the failure is dealt with.
6. Waits for the alarm to clear.

Each step polls every 15 seconds and fails the run when it times out. Queue counts lag by 30 seconds or more, and a new mapping takes minutes to start reading, so a full run takes 10 to 20 minutes.

`cleanDeskPolicy` (a trimmed copy of composureCDK's) makes everything deletable with the stack, including the failure bucket that capture retains. **Never apply it to a real capture.**

## Running it

From GitHub: run the **Deploy Test** workflow. It deploys, verifies and always destroys. It uses the `sandbox` environment's `AWS_ROLE_ARN` and `AWS_REGION`, and the role from [github-oidc-role.yml](../.github/cloudformation/github-oidc-role.yml).

Locally, with sandbox credentials:

```sh
npm run build
cd functional
npx cdk deploy --require-approval never
node run.ts
npx cdk destroy --force
```

`npm run verify` typechecks this directory and synthesises the stack, against the package's source, so neither needs a build.
