# commander-plugins

The plugin catalog for [Commander](https://github.com/enverbisevac/commander).

Every plugin lives here as a **git submodule** under `plugins/<name>`. A dev
submits their plugin's git URL, the owner reviews it, and once approved it is
added as a submodule. Pushing to `main` runs a workflow that packages every
plugin and uploads the catalog to the **object-store root** (`<bucket>/plugins/`)
— the exact location the shipped app's marketplace reads. The hosting details
(bucket, endpoint, URL) live only in repo secrets, never in this public repo.

This is intentionally **decoupled from Commander releases**: adding, updating,
or removing a plugin no longer requires cutting a new Commander build. When this
flow is proven, the bundled `plugins/` directory will be removed from the
Commander repo and this repo becomes the single source of truth.

## Why submodules

- **Pinned trust.** A submodule references one exact commit. Approving a plugin
  (or an update) means committing a specific SHA — arbitrary later pushes by the
  plugin author don't reach users until the owner re-pins and re-approves.
- **No vendoring.** Plugin source stays in its own repo, owned by its author.
- **Independent deploy.** The catalog rebuilds from whatever commits are pinned.

## Layout

```
plugins/<name>/            # one git submodule per plugin (holds plugin.json + exec)
scripts/plugins.mjs        # the whole cross-platform toolchain (Node, zero deps):
                           #   validate | add | update | remove | package | deploy
package.json               # npm-run aliases for the above
.github/
  workflows/deploy.yml     # on push to main: validate → package → deploy
  workflows/validate.yml   # on PR: validate submodules/manifests
  ISSUE_TEMPLATE/plugin-submission.yml  # the dev-facing submission form
docs/approval-flow.md      # the submit → approve → deploy runbook
```

## Tooling

Everything runs through one **cross-platform** Node CLI — no bash, no `zip`, no
`shasum`, so it works identically on macOS, Linux, and Windows. Node ≥ 18 and
`git` are the only requirements (`deploy` also uses the `aws` CLI, and runs in
CI). No `npm install` needed — there are zero dependencies.

```sh
node scripts/plugins.mjs validate                 # check manifests + structure
node scripts/plugins.mjs add <git-url> [name] --ref <tag>
node scripts/plugins.mjs update <name>|--all --ref <tag>
node scripts/plugins.mjs remove <name>
# or the npm aliases: npm run validate, npm run add -- <git-url> <name>
```

## The flow

A standard fork → PR → merge contribution, where the "code" being merged is a
pinned submodule pointer:

1. A dev **forks** this repo.
2. In the fork they add their plugin as a submodule pinned to a commit:
   `node scripts/plugins.mjs add <git-url> <name> --ref <commit>` (or `git
   submodule add` by hand), then commit.
3. They open a **PR**. `validate.yml` runs — it checks out the submodule and
   validates the manifest + repo structure. Fork PRs run with **no secrets**, so
   the validation can't deploy anything.
4. The owner **reviews the plugin's source at the pinned commit** (the PR diff
   only shows a gitlink SHA — the code lives in the referenced repo) and merges.
5. Merge to `main` triggers `deploy.yml`, which packages every plugin and uploads
   the catalog to `<bucket>/plugins/` — the shipped app picks it up in **Options
   → Plugins → Marketplace**.

Devs who'd rather not fork can instead file a **Plugin submission** issue with
their git URL; the owner then does the submodule add. Either way the merge is the
gate.

See `docs/approval-flow.md` for the full runbook and `CONTRIBUTING.md` for the
plugin protocol.

## Cloning

Because plugins are submodules, clone recursively:

```sh
git clone --recurse-submodules https://github.com/enverbisevac/commander-plugins.git
# or, after a plain clone:
git submodule update --init --recursive
```
