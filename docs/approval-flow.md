# Submit → approve → deploy runbook

## Roles

- **Dev** — builds/releases a plugin in their own public GitHub repo, then forks
  this repo and opens a PR that pins its release tag as a submodule.
- **Owner** — reviews the referenced commit's source and merges. Only the owner
  can merge to `main` (protect the branch).

## 1. Submission (dev, in a fork)

The plugin repo first runs its own tests and build. It publishes `vX.Y.Z` with
an installable `<name>.zip`; the ZIP root contains the tagged `plugin.json`.
Then the dev forks `commander-plugins` and pins that exact release tag:

```sh
node scripts/plugins.mjs add <github-url> <name> --ref vX.Y.Z
git commit -am "add <name> plugin"
```

`add` downloads and validates the release, then records its commit, tag, asset,
size, and SHA-256 in `plugins.lock.json`. A manual `git submodule add` must be
followed by `node scripts/plugins.mjs lock <name>`.

The tooling is a zero-dependency, cross-platform Node CLI (Node ≥ 18 + git), so
this works the same on macOS, Linux, and Windows. Then they push the fork and
open a PR. The submodule dir name **must** match the plugin's `plugin.json`
`name`.

`validate.yml` checks the pinned source (manifest, exec paths, capabilities,
symlinks, and safe submodule metadata), downloads the matching release asset,
and verifies its ZIP paths, manifest, exec files, modes, and locked digest. It
stages the exact bytes without uploading. **Fork PRs carry no secrets**, so a submission can
never trigger a deploy.

Devs who can't/won't fork can instead file a **Plugin submission** issue
(`.github/ISSUE_TEMPLATE/plugin-submission.yml`) with the GitHub URL + tag; the
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
- The plugin-owned workflow builds the release from the tagged source, using
  the appropriate language toolchain in that repo—not in this catalog.
- License is compatible with redistribution.

`validate.yml` green means source and release structure are sane and consistent;
it does **not** vet behavior or prove a compiled binary is benign. That's the
manual review step (and release provenance should be checked for native builds).

## 3. Approve (owner)

Merge the PR. The push to `main` triggers `deploy.yml`, which downloads and
re-verifies each release, copies the exact asset bytes into the catalog, hashes
them, and syncs to `<bucket>/plugins/`. Nothing reaches the bucket without this
merge—the catalog does not compile or repackage plugins.

## 4. Updates

A plugin update is a **re-approval**, not automatic — the submodule stays pinned
to the reviewed commit until the owner re-pins it:

```sh
node scripts/plugins.mjs update <name> --ref vX.Y.Z
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
- **Release/source consistency.** The release manifest must exactly equal the
  reviewed source manifest and every relative exec path must be present.
- **Pinned release bytes.** `plugins.lock.json` binds the reviewed commit/tag to
  an asset SHA-256 and size. Replacement after approval makes deployment fail.
- **Checksum on install.** The published `index.json` records the copied ZIP's SHA-256;
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
