# Project Instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It is the canonical guide to the gates and the project rules, and this file adds only what is specific to working as an agent.

- **Run the gates before presenting work** ([Before you open a pull request](CONTRIBUTING.md#before-you-open-a-pull-request)), and report failures with their output rather than working around them.
- **The project rules have enforcement behind them.** `check:peers`, the lowest-supported CI job and `@composurecdk/eslint-plugin` will each tell you when a rule is broken, so fix the cause rather than suppressing the check.
- **Deploying needs the sandbox role.** Anything that changes `.github/cloudformation/github-oidc-role.yml` needs a manual redeploy; say so in the PR.
