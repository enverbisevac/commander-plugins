# Submit → approve → deploy runbook

## Roles

- **Dev** — writes a plugin in their own public git repo, then forks this repo
  and opens a PR that adds their plugin as a pinned submodule.
- **Owner** — reviews the referenced commit's source and merges. Only the owner
  can merge to `main` (protect the branch).

## 1. Submission (dev, in a fork)

The dev forks `commander-plugins` and, in the fork, adds their plugin as a
submodule pinned to a specific commit:

```sh
node scripts/plugins.mjs add <git-url> <name> --ref <commit>   # or `git submodule add` by hand
git commit -am "add <name> plugin"
```

The tooling is a zero-dependency, cross-platform Node CLI (Node ≥ 18 + git), so
this works the same on macOS, Linux, and Windows. Then they push the fork and
open a PR. The submodule dir name **must** match the plugin's `plugin.json`
`name`.

`validate.yml` runs on the PR: it checks out the submodule and runs
`node scripts/plugins.mjs validate` (manifest valid, `name` matches, `protocol`
1, `exec` present, a known capability, no symlinks, and `.gitmodules` paths all
under `plugins/` with safe names/urls). **PR runs from a fork carry no secrets**,
so a submission can never trigger a deploy.

Devs who can't/won't fork can instead file a **Plugin submission** issue
(`.github/ISSUE_TEMPLATE/plugin-submission.yml`) with the git URL + commit; the
owner then performs the submodule add. The website's "Submit a plugin" button can
either link to "fork and open a PR" or open this issue.

## 2. Review (owner)

The PR diff shows only a **gitlink SHA + a `.gitmodules` entry** — never the
plugin's code. Review the plugin **at the exact pinned commit**:

```sh
git clone <git-url> /tmp/review-<name> && cd /tmp/review-<name>
git checkout <the-pinned-sha>       # copy it from the PR's submodule pointer
```

Check:

- `plugin.json` is valid, `name` matches the submodule dir, `protocol` is 1,
  `exec` is present, and it declares a known capability
  (viewer/thumbnail/packer/fs/converter).
- The executable does only what it claims — no network exfiltration, no writing
  outside the paths the host passes it, no obfuscated payloads.
- Runtime deps are reasonable and documented (e.g. `python3`, a system CLI).
- License is compatible with redistribution.

`validate.yml` green means the manifest and structure are sane; it does **not**
vet behavior. That's this manual step.

## 3. Approve (owner)

Merge the PR. The push to `main` triggers `deploy.yml`, which packages the whole
catalog and syncs it to `<bucket>/plugins/`. Nothing reaches the bucket without
this merge — that's the entire trust gate.

## 4. Updates

A plugin update is a **re-approval**, not automatic — the submodule stays pinned
to the reviewed commit until the owner re-pins it:

```sh
node scripts/plugins.mjs update <name> --ref <new-reviewed-commit>
git diff                    # confirm only the submodule pointer moved
git commit -am "update <name> plugin" && git push
```

## 5. Removal

```sh
node scripts/plugins.mjs remove <name>
git commit -am "remove <name> plugin" && git push
```

The deploy sync runs with `--delete`, so the removed plugin's objects are pruned
from the bucket and it disappears from the marketplace.

## Security model

- **Pinned commits.** Users only ever receive the exact commit the owner
  reviewed and committed. Arbitrary later pushes by the plugin author do nothing
  until re-approved (step 4).
- **Checksum on install.** The published `index.json` records each zip's SHA-256;
  the app verifies it before extracting.
- **Manifest validation** happens twice: here in CI, and again in the app on
  install (name match, protocol ceiling, safe name, no symlinks).
- **Branch protection.** `main` should require the owner's review so no plugin
  reaches storage without a human approval.

## Relationship to Commander

- The shipped app's marketplace reads the catalog from the object-store root
  (`<base>/plugins/index.json`), which is exactly what this repo publishes. No
  Commander rebuild is needed to add/update a plugin.
- While the app also bundles its own example plugins in parallel, make sure its
  build points the marketplace at that same root catalog. Once this repo is
  proven, the bundled plugins and their packaging can be removed from the app so
  this repo is the single source of truth.
