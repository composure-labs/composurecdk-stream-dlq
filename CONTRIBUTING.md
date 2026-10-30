# Contributing

Thanks for your interest. This package is **pre-1.0** and its API is not settled yet, so we work **issue-first**: open an issue before a large pull request, and we'll agree on fit and approach before anyone writes code. Small, obvious fixes (typos, broken links, one-line bugs) are welcome as direct pull requests. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

The package is built only on ComposureCDK's _published_ API. Its [architecture guide](https://github.com/laazyj/composureCDK/blob/main/docs/architecture.md) explains the shape of builders, `compose`, refs and grants. The design and the plan for this package live in [laazyj/composureCDK#623](https://github.com/laazyj/composureCDK/issues/623).

## Development setup

Prerequisites: **Node.js >= 22** for development (consumers need only Node >= 20), and **shellcheck** on your `PATH` if you change `.github/workflows/` (`brew install shellcheck`).

```sh
git clone https://github.com/composure-labs/composurecdk-stream-dlq.git
cd composurecdk-stream-dlq
npm ci
```

This is a single npm package, so `package.json` scripts are the task runner; there is no nx. Keep each script a plain command.

## Before you open a pull request

```sh
npm run verify          # every gate; the pre-push hook and CI's Verify job run it
npm run check:consumer  # pack, install as a consumer would, load through import and require()
npx actionlint          # only if you changed .github/workflows/
```

The [deploy test](functional/README.md) runs against the sandbox account, so it is a manual workflow, not a gate.

Auto-fix with `npm run format` and `npx eslint . --fix`. If you change `.github/workflows/` or `dependabot.yml`, CI also runs [zizmor](https://docs.zizmor.sh); fix its findings, or suppress one with a reason.

**Keep `verify` fast.** Unlike ComposureCDK, this repo has no task cache, so the pre-push hook re-runs every gate on every push. It prints how long it took. It's about 20 seconds today. If it grows past about 30 seconds, move the slow gates to CI only rather than training people to `--no-verify`.

## Project rules

- **Every peer is mirrored as a devDependency with the _identical_ range string**, or the compat loop silently stops widening peers. When you add a peer, add the same range to `devDependencies`. `npm run check:peers` enforces it; [`scripts/check-peer-mirror.mjs`](scripts/check-peer-mirror.mjs) explains why.
- **A peer floor is the highest of this package's own usage and its peers' floors** (ComposureCDK [ADR-0008](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0008-aws-cdk-lib-version-floors.md)). `aws-cdk-lib` is `^2.184.0` because of S3 on-failure destinations for DynamoDB and Kinesis. `constructs` is `^10.8.1` because `@composurecdk/core` needs it, which [laazyj/composureCDK#634](https://github.com/laazyj/composureCDK/issues/634) tracks lowering. Raising a floor is a deliberate change; CI's lowest-supported job proves the floors.
- **Dual ESM/CJS, built by tshy.** No `import.meta` or top-level `await` in `src/`, and brand checks use `Symbol.for(...)`, not `instanceof`. `@composurecdk/eslint-plugin`'s `dualPublishing` and `recommended` presets enforce both.
- **No bundler.** A Lambda handler ships as a typed, unit-tested function serialised with `.toString()` into `Code.fromInline` (ComposureCDK [ADR-0016](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0016-domain-action-custom-resource.md)). A bundler can inject helpers into a function body and break that serialisation.
- **Double quotes** (Prettier `"singleQuote": false`).
- **Commits and PR titles** use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.
- **No CHANGELOG file.** Releases use generated GitHub Release notes, so describe behaviour changes in the PR body.

## AWS

Workflows that deploy assume `github-actions-composure-labs-stream-dlq` through the `sandbox` environment. Every stack is named `ComposureLabs-StreamDlq-*`, and the role's permissions are scoped to that prefix (see [`.github/cloudformation/github-oidc-role.yml`](.github/cloudformation/github-oidc-role.yml)), so CI can't deploy or inspect a stack outside it. A change to that template must be redeployed by hand before the workflow that needs it runs.

## Releasing

Maintainers run the **Release** workflow by hand with the version to publish. It sets the version, runs `verify`, and publishes to npm through trusted publishing (OIDC), with provenance. It then publishes the GitHub Release, which creates the `v<version>` tag. The version lives in the tag and on npm; `package.json` on `main` stays at `0.0.0`. Until 1.0, releases are plain `0.x` versions on `latest`, and a minor release may break the API. A prerelease version, such as `1.0.0-rc.1`, would go under the `next` dist-tag instead.

Nothing approves a run after it starts, so the gate is who can run it: the `npm` environment deploys only from protected branches, and the package's trusted publisher on npmjs.com (GitHub, this repository, `release.yml`, environment `npm`) must allow `npm publish`.

If npm publishes and the GitHub Release step fails, don't run the workflow again: the version is already on npm. Create the release by hand, with the commit the run built: `gh release create v<version> --target <sha> --title v<version> --generate-notes`.

## License

[MIT](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
