# Writing a Commander plugin

A plugin is an **external executable + a `plugin.json` manifest** at the root of
your git repo. Commander drives it as a one-shot subprocess:
`<exec...> <method> <paramsJson>`, reads one JSON object from stdout, and falls
back to built-in behavior if it errors. The full protocol (every method, params,
and reply shape) lives in the Commander repo:
[`docs/plugins.md`](https://enver.bisevac.com/docs/commander-plugins).
This page is the summary you need to submit here.

## `plugin.json`

```json
{
  "name": "my-viewer",
  "version": "1.0.0",
  "protocol": 1,
  "description": "Preview WHATEVER files as a table.",
  "exec": ["python3", "./my_viewer.py"],
  "capabilities": {
    "viewer": { "extensions": ["whatever"], "priority": 50 }
  },
  "platforms": ["macos", "linux", "windows"],
  "publisher": "Your Name",
  "homepage": "https://github.com/you/my-viewer",
  "license": "MIT"
}
```

| field          | meaning |
| -------------- | ------- |
| `name`         | Unique id. `A-Z a-z 0-9 . _ -`, 1–96 chars. **Must match your submodule/repo name here.** |
| `version`      | Free-form version string. |
| `protocol`     | Protocol version. The host refuses `> 1`. |
| `exec`         | Argv prefix. An element starting with `./`/`../` resolves against the plugin's own dir; anything else (`python3`, an absolute path) is used verbatim. The host appends the method + params. |
| `capabilities` | What the plugin can do — declare at least one (below). |
| `platforms`    | Optional; defaults to all three. Marketplace hides plugins that don't support the user's OS. |

## Capabilities

- **`viewer`** — render a file in Quick View / F3.
  `{ "extensions": [...], "priority": <int> }`. Method: `viewer.render`.
- **`thumbnail`** — render thumbnails/gallery tiles.
  `{ "extensions": [...], "priority": <int> }`. Method: `thumbnail.render`
  `{path, px}` → `{ok, mime, data_base64}`.
- **`packer`** — pack/unpack an archive format (7z, rar, `.cbz`, …).
  `{ "extensions": [...], "can_create": <bool> }`. Methods: `packer.list`,
  `packer.extract`, `packer.create`.
- **`fs`** — browse storage the OS can't mount as a read-only pane.
  `{ "schemes": [...], "container_exts": [...], "read_only": <bool> }`. Methods:
  `fs.list`, `fs.read`.
- **`converter`** — add format pairs to the Convert dialog.
  `{ "inputs": [...], "outputs": [...], "priority": <int> }`. Method:
  `converter.convert` `{src, dst, from, to}`.

## Rules

- One JSON object on stdout, then exit. `{"ok":true,...}` or
  `{"ok":false,"error":"..."}`. Non-zero exit / oversized stdout / timeout is a
  host failure → the host falls back.
- **No symlinks** in the repo — installs reject them.
- Keep runtime deps minimal and documented (a bundled interpreter script or a
  common system CLI). Don't reach outside the paths the host passes you, and
  don't phone home.
- Long packer ops can stream `@progress <done> <total>` on **stderr** for a live
  bar (see `docs/plugins.md`).

## Test locally before submitting

Commander can sideload a plugin directory (Options → Plugins → **Load local
plugin…**), or copy it into the plugins dir manually:

- macOS: `~/Library/Application Support/Commander/plugins/<name>`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/commander/plugins/<name>`
- Windows: `%APPDATA%\Commander\plugins\<name>`

## Versioning

Your plugin repo owns its own versioning — its own `vX.Y.Z` tags, GitHub
releases, and changelog, independent of Commander and of this catalog. The
catalog pins your plugin to a **release tag**.

Convention: **tag `vX.Y.Z` ⟺ `plugin.json` `"version": "X.Y.Z"`**. To ship an
update:

1. Bump `plugin.json` `version`, commit, and tag `vX.Y.Z` in your repo.
2. Open a PR here (or ask the owner) to re-pin the submodule to the new tag.

The catalog stores each version at `plugins/<name>/<version>/<name>.zip`, so a
version bump publishes a fresh, immutable path. Re-pinning to a new commit
**without** bumping the version overwrites the same URL with different bytes —
always bump the version.

## Submit

Fork this repo, add your plugin as a submodule pinned to your release tag, and
open a PR:

```sh
node scripts/plugins.mjs add <git-url> <name> --ref vX.Y.Z
node scripts/plugins.mjs validate
git commit -am "add <name> plugin"     # then push your fork and open a PR
```

The tooling is a zero-dependency Node CLI (Node ≥ 18 + git) — it runs the same on
macOS, Linux, and Windows. Or, if you'd rather not fork, open a **Plugin
submission** issue with your public git URL + tag. See
[`docs/approval-flow.md`](docs/approval-flow.md) for what happens next.
