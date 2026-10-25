# Project Instructions

This package is a **composure-labs** sibling of [composureCDK](https://github.com/laazyj/composureCDK). It is built only on composureCDK's _published_ API, so read composureCDK's [architecture guide](https://github.com/laazyj/composureCDK/blob/main/docs/architecture.md) for the shape of builders, `compose`, refs and grants. The design and the plan are in [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623).

## After making changes

```sh
npm run verify          # what the pre-push hook and CI's Verify job run
npm run check:consumer  # pack + install + load through import and require(); run on Node
npx actionlint          # only if you touched .github/workflows/
```

Auto-fix with `npm run format` and `npx eslint . --fix`. If you touched `.github/workflows/` or `dependabot.yml`, CI also runs zizmor; fix or suppress its findings with a reason.

## Rules

- **Every peer is mirrored as a devDependency with the _identical_ range string.** Dependabot ignores `peerDependencies` and rewrites a peer only when its range equals the devDependency it bumps; that is how the compat loop widens `^0.11.0` to `^0.11.0 || ^0.12.0`. `npm run check:peers` enforces it. When you add a peer, add the same range to `devDependencies`.
- **A peer floor is the highest of this package's own usage and its peers' floors** (composureCDK ADR-0008). `aws-cdk-lib` is `^2.184.0` because of S3 on-failure destinations for DynamoDB/Kinesis; `constructs` is `^10.8.1` because `@composurecdk/core` needs it. Raising a floor is a deliberate change; CI's lowest-supported job proves the floors.
- **Dual ESM/CJS, built by tshy.** No `import.meta` or top-level `await` in `src/`, and brand checks use `Symbol.for(...)`, not `instanceof`. `@composurecdk/eslint-plugin`'s `dualPublishing` and `recommended` presets enforce both.
- **No bundler.** A Lambda handler ships as a typed, unit-tested function serialised with `.toString()` into `Code.fromInline` (composureCDK ADR-0016). A bundler can inject helpers into a function body and break that serialisation.
- **`package.json` scripts are the task runner.** This is a single npm package, so there is no nx; keep each script a plain command.
- **Double quotes** (Prettier `"singleQuote": false`).
- **No CHANGELOG file.** Releases use generated GitHub Release notes; describe behaviour changes in the PR body.
- Commits use Conventional Commits: `<type>(<scope>): <description>`.

## AWS

Workflows that deploy assume `github-actions-composure-labs-stream-dlq` through the `sandbox` environment. Every stack is named `ComposureLabs-StreamDlq-*`; the role's permissions are scoped to that prefix (see [`.github/cloudformation/github-oidc-role.yml`](.github/cloudformation/github-oidc-role.yml)). A stack outside the prefix cannot be deployed or inspected by CI. A change to that template must be redeployed by hand before the workflow that needs it runs.
