# Plugin-owned release contract

This catalog is a review and distribution gate, not a build farm. Every plugin
repository owns its language toolchain, tests, build, and GitHub release.

## Required release shape

For `plugin.json` name `example-viewer` and version `1.2.3`:

- The reviewed submodule commit has exact tag `v1.2.3`.
- GitHub release `v1.2.3` has an asset named `example-viewer.zip`.
- `plugin.json` is at the ZIP root and parses identically to the tagged source
  manifest. Formatting and object-key order may differ; values may not.
- Every `./` or `../` path in `exec` exists in the ZIP and stays inside its root.
- If `exec[0]` is a relative file, its executable mode is preserved in the ZIP.
- The ZIP contains no symlinks, duplicate paths, absolute paths, or traversal.
- The ZIP is at most 256 MiB.

An alternate asset filename may be declared in the source manifest:

```json
{
  "release": { "artifact": "example-viewer-universal.zip" }
}
```

The catalog downloads that asset, checks it, computes its SHA-256, and writes
the same bytes to `plugins/<name>/<version>/<name>.zip`. It does not run a
compiler, install dependencies, or generate a new ZIP.

`plugins.lock.json` pins the reviewed source commit, tag, asset name, size, and
SHA-256. `package` downloads the release again and refuses it if any locked
value changed. This prevents an asset replacement between PR approval and
deployment.

You can apply the same artifact checks before publishing:

```sh
node scripts/plugins.mjs verify-release /path/to/plugin /path/to/plugin.zip
node scripts/plugins.mjs lock <plugin-name> # download, verify, and pin its bytes
```

## Example for a source-only plugin

Python or another source-only plugin can use a workflow like this. The test step
is deliberately owned by the plugin repo and should be changed for that plugin.

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Test
        run: python3 -m unittest discover -s tests

      - name: Check tag and manifest version
        id: plugin
        shell: bash
        run: |
          name="$(node -p "require('./plugin.json').name")"
          version="$(node -p "require('./plugin.json').version")"
          test "$GITHUB_REF_NAME" = "v$version"
          echo "name=$name" >> "$GITHUB_OUTPUT"

      - name: Build release asset
        shell: bash
        run: git archive --format=zip --output "$RUNNER_TEMP/${{ steps.plugin.outputs.name }}.zip" HEAD

      - name: Publish release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" "$RUNNER_TEMP/${{ steps.plugin.outputs.name }}.zip" --verify-tag --generate-notes
```

If a source-only plugin has no tests yet, add a meaningful smoke test rather
than keeping a knowingly failing placeholder command.

## Compiled plugins

A Go, Rust, Zig, or other compiled plugin uses the same external contract, but
its own workflow builds the required targets and assembles the final ZIP. Keep
all toolchain setup and cross-compilation in that repository. A launcher inside
the ZIP may select the correct platform binary, or the plugin may use another
layout supported by Commander; in either case, the shipped `plugin.json` must
match the reviewed source manifest.

For compiled artifacts, publish build provenance/attestations from the plugin
workflow so reviewers can connect the binaries to the tagged source. Structural
catalog validation is not a substitute for provenance or source review.

## Migrating an existing catalog entry

1. Commit the release workflow in the plugin repository.
2. Bump `plugin.json`, commit, and tag a new release (the workflow cannot be
   retroactively added to an older tagged source tree).
3. Let the plugin workflow publish its ZIP asset.
4. In this repo, run `node scripts/plugins.mjs update <name> --ref vX.Y.Z`.
   The command re-pins source and updates `plugins.lock.json`.
5. Review both the submodule commit and lock digest in the catalog PR.
