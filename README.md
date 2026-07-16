# commander-plugins

The plugin catalog for [Commander](https://enver.bisevac.com/commander).

Every plugin lives here as a **git submodule** under `plugins/<name>`, pinned to
an exact release tag. The plugin repository owns its build and publishes a
`<name>.zip` GitHub Release asset. This repo is only the trust gate: it reviews
and validates the pinned source, verifies the release ZIP against that source,
then copies the exact downloaded bytes to the object-store catalog. It never
builds plugin code or repackages a release.

This is intentionally **decoupled from Commander releases**: adding, updating,
or removing a plugin no longer requires cutting a new Commander build. When this
flow is proven, the bundled `plugins/` directory will be removed from the
Commander repo and this repo becomes the single source of truth.

## Why submodules

- **Pinned trust.** A submodule references one exact commit. Approving a plugin
  (or an update) means committing a specific SHA — arbitrary later pushes by the
  plugin author don't reach users until the owner re-pins and re-approves.
- **No vendoring.** Plugin source stays in its own repo, owned by its author.
- **Independent builds.** Each plugin chooses its own language, toolchain, tests,
  and release workflow; the catalog needs only Node and Git.
- **Artifact integrity.** The release ZIP's root `plugin.json` must exactly match
  the reviewed source manifest, its relative exec paths must exist, and unsafe
  paths/symlinks are rejected. The catalog then hashes and copies it unchanged.

## Layout

```
plugins/<name>/            # reviewed source, pinned to the matching vX.Y.Z tag
plugins.lock.json          # reviewed release commit + asset SHA-256/size
scripts/plugins.mjs        # the whole cross-platform toolchain (Node, zero deps):
                           #   validate | lock | add | update | remove | package | deploy
package.json               # npm-run aliases for the above
.github/
  workflows/deploy.yml     # on push to main: validate → package → deploy
  workflows/validate.yml   # on PR: validate submodules/manifests
  ISSUE_TEMPLATE/plugin-submission.yml  # the dev-facing submission form
docs/approval-flow.md      # the submit → approve → deploy runbook
```

## Tooling

Everything in this catalog runs through one **cross-platform** Node CLI. Node ≥
18 and `git` are the only requirements (`deploy` also uses the `aws` CLI in CI).
No plugin language toolchain and no `npm install` are needed.

```sh
node scripts/plugins.mjs validate                 # check manifests + structure
node scripts/plugins.mjs add <github-url> [name] --ref <tag>
node scripts/plugins.mjs update <name>|--all --ref <tag>
node scripts/plugins.mjs remove <name>
node scripts/plugins.mjs lock <name>|--all          # pin approved release bytes
node scripts/plugins.mjs verify-release <plugin-dir> <archive.zip>
npm test                                           # test the catalog gate
# or the npm aliases: npm run validate, npm run add -- <git-url> <name>
```

## The flow

A standard fork → PR → merge contribution, where the "code" being merged is a
pinned submodule pointer:

1. A dev **forks** this repo.
2. In the plugin repo they build and publish GitHub release `vX.Y.Z` with an
   asset named `<name>.zip`. Its root contains the same `plugin.json` as the tag.
3. In the fork they add their plugin as a submodule pinned to that tag:
   `node scripts/plugins.mjs add <git-url> <name> --ref vX.Y.Z`, then commit.
4. `add` records the release asset's SHA-256/size in `plugins.lock.json`. They
   open a **PR** containing the submodule pointer and lock change.
5. `validate.yml` checks the source, downloads the named release asset, verifies
   its contents and locked bytes, and stages it without uploading.
   Fork PRs run with **no secrets**, so validation cannot deploy anything.
6. The owner **reviews the plugin's source at the pinned commit** (the PR diff
   only shows a gitlink SHA — the code lives in the referenced repo) and merges.
7. Merge to `main` triggers `deploy.yml`, which re-verifies and copies every
   release asset to `<bucket>/plugins/` — the shipped app picks it up in
   **Options → Plugins → Marketplace**.

Devs who'd rather not fork can instead file a **Plugin submission** issue with
their git URL; the owner then does the submodule add. Either way the merge is the
gate.

See `docs/release-contract.md` for the artifact contract,
`docs/approval-flow.md` for the runbook, and `CONTRIBUTING.md` for the protocol.

## Cloning

Because plugins are submodules, clone recursively:

```sh
git clone --recurse-submodules https://github.com/enverbisevac/commander-plugins.git
# or, after a plain clone:
git submodule update --init --recursive
```
