# GitHub Actions in m407/Handy

All nine workflows from `cjpais/Handy` at commit
`9e57a0d7929fcc6417ea0d6e54c1b57f62635edd` are retained. There are no
Copilot workflow files in that source revision, and none were added.
GitHub-managed Copilot workflows shown in the upstream Actions UI are not
repository files and are not part of this configuration.

| Workflow          | Trigger / purpose                                                                 |
| ----------------- | --------------------------------------------------------------------------------- |
| code quality      | Relevant pushes/PRs and manual runs; translations, utilities, lint and formatting |
| test              | Rust changes/PRs and manual runs; Rust tests                                      |
| Playwright        | Frontend PRs and manual runs; browser tests                                       |
| nix build check   | Relevant pushes/PRs and manual runs; Nix evaluation and builds                    |
| Build             | Reusable cross-platform build, called by the workflows below                      |
| Main Branch Build | Pushes to `main` or manual runs; unsigned installable artifacts                   |
| Build Test        | Manual; unsigned test artifacts                                                   |
| PR Test Build     | Manual PR number; unsigned artifacts and a download link on the PR                |
| Release           | Manual; draft release in this repository, unsigned by default                     |

The original seven-entry Linux, macOS and Windows build matrix is preserved.
PR and test builds do not receive signing secrets. The shared build inherits
its caller's token permissions: ordinary builds are read-only, release builds
can upload to a draft release. PR comments have a separate narrowly scoped job.

## Enable and run

After merging the workflow changes into `main`, open the repository's **Actions**
tab. If GitHub has disabled Actions for the fork, enable them there. In
**Settings → Actions → General**, allow the actions referenced by these files
(or allow all actions). GitHub repository settings and secrets are not copied
by forking or by copying YAML files.

Use **Run workflow** on Build Test or Main Branch Build to produce installers.
Release creates a **draft**, which must be checked before publishing. This change
does not publish a release or start the full build matrix automatically from
this development branch.

## Signing and updates

No signing credentials are required for default builds. The CI configuration
step removes upstream's Azure signing command, disables updater artifacts and
clears the upstream updater endpoint/key in the build workspace. Unsigned builds
therefore cannot replace this fork with an upstream release via auto-update.
The checked-in development configuration is not rewritten by this step locally.

To run Release with `sign-binaries` enabled, configure credentials owned by this
repository:

- Variable `TAURI_SIGNING_PUBLIC_KEY` and secrets `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for Tauri updater signing.
- Apple secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_ID_PASSWORD` / `APPLE_PASSWORD`,
  `APPLE_TEAM_ID` as required by the Apple account and tauri-action.
- Variable `WINDOWS_SIGN_COMMAND` containing the signing command for your own
  Azure account/profile, plus `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and
  `AZURE_TENANT_ID` secrets. The existing workflow installs trusted-signing-cli.

Signed updater manifests point to this repository's releases and use its own
public key. No upstream signing account, profile or public key is reused.

## Nix cache

By default, Nix can read the public `handy-computer` cache but never pushes to it.
Optionally set variable `CACHIX_CACHE_NAME` to a cache you own and secret
`CACHIX_AUTH_TOKEN` to its token. Cache writes are allowed only on push/manual
runs; PR runs remain read-only and receive no cache credential.

## Validation

Run `node scripts/configure-ci-build.test.mjs` for signed/unsigned config
regressions and `actionlint` to validate workflow syntax and reusable-workflow
interfaces. Older actionlint releases may need the upstream runner labels
`macos-26`, `ubuntu-24.04-arm` and `windows-11-arm` configured as known runners.
Actual packaging, signing and release uploads require GitHub-hosted runners and,
for signed releases, the credentials listed above.
