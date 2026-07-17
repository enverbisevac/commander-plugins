#!/usr/bin/env node
//
// Cross-platform plugin-catalog toolchain (macOS / Linux / Windows). Uses only
// Node built-ins + `git`; `deploy` additionally shells out to the `aws` CLI.
// No language toolchains are used here: plugin repositories build and publish
// their own release ZIPs, and this catalog validates + copies those exact bytes.
//
// Commands:
//   node scripts/plugins.mjs validate
//   node scripts/plugins.mjs add <git-url> [name] [--ref <branch-or-tag-or-sha>]
//   node scripts/plugins.mjs update <name>|--all [--ref <ref>]
//   node scripts/plugins.mjs remove <name>
//   node scripts/plugins.mjs lock <name>|--all
//   node scripts/plugins.mjs verify-release <plugin-dir> <archive.zip>
//   node scripts/plugins.mjs package        # fetch verified release assets into dist/plugins/
//   node scripts/plugins.mjs deploy         # package + sync to the object store
//
// (npm run aliases exist: `npm run validate`, `npm run add -- <url> <name>`, …)

import {
  readFileSync, writeFileSync, readdirSync, statSync, lstatSync,
  mkdirSync, rmSync, existsSync,
} from "node:fs";
import { join, basename, dirname, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = process.env.PLUGINS_SRC || join(ROOT, "plugins");
const LOCK_PATH = join(ROOT, "plugins.lock.json");

const SAFE_NAME = /^[A-Za-z0-9._-]{1,96}$/;
const SAFE_PATH = /^plugins\/[A-Za-z0-9._-]{1,96}$/;
const SAFE_URL = /^(https:\/\/|ssh:\/\/|git@)/;
const SAFE_ASSET = /^[A-Za-z0-9._-]{1,160}\.zip$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KNOWN_CAPS = ["viewer", "thumbnail", "packer", "fs", "converter"];
const ZIP_EXCLUDE = new Set([".git", ".github", ".gitignore", ".gitmodules", ".DS_Store"]);
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function die(msg) { console.error(msg); process.exit(1); }
function run(args, cwd = ROOT) {
  try { execFileSync("git", args, { cwd, stdio: "inherit" }); }
  catch { die(`\nERROR: 'git ${args.join(" ")}' failed (see output above).`); }
}
function capture(args, cwd = ROOT) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function captureOr(args, cwd, fb = "") { try { return capture(args, cwd); } catch { return fb; } }

// Is a submodule path referenced by .gitmodules or the index? Used to tell a
// truly-orphaned .git/modules dir (safe to drop) from a live one.
function isRegistered(rel) {
  if (existsSync(join(ROOT, ".gitmodules")) && parseGitmodules().some((m) => m.path === rel)) return true;
  return captureOr(["ls-files", "--stage", "--", rel]).length > 0;
}

// Fetch + detach-checkout a ref in a submodule, verifying it resolves first so a
// missing tag gives a clear message (git's own error is "--detach does not take
// a path argument").
function checkoutRef(dest, ref) {
  run(["fetch", "--tags", "origin"], dest);
  if (!captureOr(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dest)) {
    const tags = captureOr(["tag", "--list"], dest).split(/\r?\n/).filter(Boolean);
    die(`\nERROR: ref '${ref}' not found in the plugin repo after fetch.\n` +
        `  Is the tag pushed? Available tags: ${tags.length ? tags.join(", ") : "(none)"}`);
  }
  run(["checkout", "--detach", ref], dest);
}

function readManifest(dir) { return JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")); }

function readLock() {
  if (!existsSync(LOCK_PATH)) return { schema: 1, plugins: {} };
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  if (lock.schema !== 1 || !lock.plugins || typeof lock.plugins !== "object") die("ERROR: invalid plugins.lock.json");
  return lock;
}

function writeLock(lock) {
  lock.plugins = Object.fromEntries(Object.entries(lock.plugins).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

function relativeExecPaths(manifest) {
  return (manifest.exec || []).filter((arg) => typeof arg === "string" && (arg.startsWith("./") || arg.startsWith("../")));
}

function validateExecPaths(manifest, hasPath) {
  const errs = [];
  for (const raw of relativeExecPaths(manifest)) {
    const normalized = posix.normalize(raw.replaceAll("\\", "/"));
    if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
      errs.push(`exec path escapes plugin root: ${raw}`);
    } else {
      const rel = normalized.replace(/^\.\//, "");
      if (!hasPath(rel)) errs.push(`exec path does not exist: ${raw}`);
    }
  }
  return errs;
}

function pluginDirs() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR)
    .filter((e) => e !== ".gitkeep")
    .map((e) => join(PLUGINS_DIR, e))
    .filter((d) => { try { return statSync(d).isDirectory() && existsSync(join(d, "plugin.json")); } catch { return false; } })
    .sort();
}

// ---- validate ------------------------------------------------------------

function parseGitmodules() {
  const p = join(ROOT, ".gitmodules");
  if (!existsSync(p)) return [];
  const mods = [];
  let cur = null;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[submodule\s+"([^"]*)"\]$/);
    if (sec) { cur = { name: sec[1], path: "", url: "" }; mods.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    if (k === "path") cur.path = kv[2].trim();
    if (k === "url") cur.url = kv[2].trim();
  }
  return mods;
}

function validate() {
  let fail = false, count = 0;

  // Repo structure first: a PR diff only shows a gitlink + a .gitmodules entry,
  // so guard that no submodule escapes plugins/ or uses a non-https/ssh url.
  for (const mod of parseGitmodules()) {
    if (!SAFE_PATH.test(mod.path)) {
      console.error(`FAIL .gitmodules: submodule path '${mod.path}' must be plugins/<safe-name>`);
      fail = true;
    }
    if (!SAFE_URL.test(mod.url)) {
      console.error(`FAIL .gitmodules: unsafe submodule url '${mod.url}' (https/ssh only)`);
      fail = true;
    }
  }

  for (const dir of (existsSync(PLUGINS_DIR) ? readdirSync(PLUGINS_DIR) : [])) {
    if (dir === ".gitkeep") continue;
    const full = join(PLUGINS_DIR, dir);
    if (!statSync(full).isDirectory()) continue;
    const mp = join(full, "plugin.json");
    if (!existsSync(mp)) { console.error(`FAIL ${dir}: missing plugin.json`); fail = true; continue; }
    let m;
    try { m = JSON.parse(readFileSync(mp, "utf8")); }
    catch (e) { console.error(`FAIL ${dir}: invalid JSON: ${e.message}`); fail = true; continue; }

    const errs = [];
    const name = m.name || "";
    if (!SAFE_NAME.test(name) || name === "." || name === "..") errs.push(`bad name "${name}" (1-96 chars: A-Z a-z 0-9 . _ -)`);
    if (name && name !== dir) errs.push(`name "${name}" != submodule dir "${dir}"`);
    if (typeof m.version !== "string" || !SAFE_VERSION.test(m.version)) errs.push("version must be SemVer (for release tag v<version>)");
    const proto = m.protocol == null ? 1 : m.protocol;
    if (typeof proto !== "number" || proto > 1) errs.push(`unsupported protocol ${proto} (max 1)`);
    if (!Array.isArray(m.exec) || m.exec.length === 0 || m.exec.some((arg) => typeof arg !== "string" || !arg)) {
      errs.push("exec must be a non-empty array of non-empty strings");
    } else {
      errs.push(...validateExecPaths(m, (rel) => existsSync(join(full, ...rel.split("/")))));
    }
    const caps = Object.keys(m.capabilities || {}).filter((k) => KNOWN_CAPS.includes(k));
    if (caps.length === 0) errs.push("no known capability (viewer/thumbnail/packer/fs/converter)");
    if (m.release != null) {
      if (!m.release || typeof m.release !== "object" || Array.isArray(m.release)) errs.push("release must be an object");
      else if (m.release.artifact != null && (!SAFE_ASSET.test(m.release.artifact) || basename(m.release.artifact) !== m.release.artifact)) {
        errs.push(`unsafe release.artifact '${m.release.artifact}'`);
      }
    }
    // Reject symlinks in the tree (the app refuses them on install).
    for (const link of findSymlinks(full)) errs.push(`symlink not allowed: ${link}`);

    if (errs.length) { console.error(`FAIL ${dir}: ${errs.join("; ")}`); fail = true; }
    else { console.log(`  ✓ ${name} ${m.version}`); count++; }
  }

  if (fail) die("Plugin validation failed.");
  console.log(`Validated ${count} plugin(s).`);
}

function findSymlinks(dir, rel = "", out = []) {
  for (const name of readdirSync(dir)) {
    if (ZIP_EXCLUDE.has(name)) continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) out.push(rel ? `${rel}/${name}` : name);
    else if (st.isDirectory()) findSymlinks(full, rel ? `${rel}/${name}` : name, out);
  }
  return out;
}

// ---- release artifact verification + packaging ---------------------------

function githubRepoUrl(gitUrl) {
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = gitUrl.match(pattern);
    if (match) return `https://github.com/${match[1]}/${match[2]}`;
  }
  return "";
}

function releaseInfo(dir, manifest) {
  const name = manifest.name;
  const tag = `v${manifest.version}`;
  let taggedCommit = captureOr(["rev-list", "-n", "1", tag], dir);
  if (!taggedCommit) {
    console.log(`Fetching release tag ${tag} for ${name}`);
    run(["fetch", "--depth", "1", "origin", `refs/tags/${tag}:refs/tags/${tag}`], dir);
    taggedCommit = captureOr(["rev-list", "-n", "1", tag], dir);
  }
  const reviewedCommit = captureOr(["rev-parse", "HEAD"], dir);
  if (!taggedCommit || taggedCommit !== reviewedCommit) {
    die(`ERROR: ${name}: reviewed commit ${reviewedCommit || "unknown"} must be exact tag '${tag}'`);
  }

  const mod = parseGitmodules().find((entry) => entry.path === `plugins/${name}`);
  if (!mod) die(`ERROR: ${name}: missing .gitmodules entry`);
  const repoUrl = githubRepoUrl(mod.url);
  if (!repoUrl) die(`ERROR: ${name}: release downloads currently require a github.com submodule URL`);
  const artifact = manifest.release?.artifact || `${name}.zip`;
  if (!SAFE_ASSET.test(artifact) || basename(artifact) !== artifact) {
    die(`ERROR: ${name}: unsafe release artifact name '${artifact}'`);
  }
  const url = `${repoUrl}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`;
  return { tag, artifact, url };
}

function artifactError(label, message) {
  throw new Error(`ERROR: ${label}: ${message}`);
}

async function download(url, label) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "commander-plugins-catalog" },
    });
  } catch (error) {
    artifactError(label, `release download failed: ${error.message}`);
  }
  if (!response.ok) artifactError(label, `release download returned HTTP ${response.status}: ${url}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RELEASE_BYTES) artifactError(label, `release asset exceeds ${MAX_RELEASE_BYTES} bytes`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_RELEASE_BYTES) artifactError(label, `release asset exceeds ${MAX_RELEASE_BYTES} bytes`);
  return buf;
}

function zipEntries(buf, label) {
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) artifactError(label, "invalid ZIP (end record not found)");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    artifactError(label, "multi-disk ZIPs are not supported");
  }
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      artifactError(label, "invalid ZIP central directory");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const parts = name.split("/");
    if ((flags & 1) !== 0) artifactError(label, "encrypted ZIP entries are not supported");
    if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") ||
        parts.some((part, index) => (part === "" && index !== parts.length - 1) || part === "." || part === "..")) {
      artifactError(label, `unsafe ZIP path '${name}'`);
    }
    const unixType = (externalAttrs >>> 16) & 0o170000;
    if (unixType === 0o120000) artifactError(label, `symlink not allowed: ${name}`);
    if (entries.has(name)) artifactError(label, `duplicate ZIP path '${name}'`);
    entries.set(name, {
      name, method, compressedSize, size, localOffset,
      mode: (externalAttrs >>> 16) & 0o7777,
      directory: name.endsWith("/"),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry, label) {
  const offset = entry.localOffset;
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) {
    artifactError(label, `invalid local ZIP entry for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) artifactError(label, `truncated ZIP entry ${entry.name}`);
  const compressed = buf.subarray(start, end);
  let raw;
  if (entry.method === 0) raw = compressed;
  else if (entry.method === 8) raw = inflateRawSync(compressed);
  else artifactError(label, `unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (raw.length !== entry.size) artifactError(label, `invalid uncompressed size for ${entry.name}`);
  return raw;
}

function verifyReleaseZip(buf, sourceManifest, label) {
  const entries = zipEntries(buf, label);
  const manifestEntry = entries.get("plugin.json");
  if (!manifestEntry || manifestEntry.directory) artifactError(label, "ZIP must contain plugin.json at its root");
  if (manifestEntry.size > MAX_MANIFEST_BYTES) artifactError(label, "plugin.json exceeds 1 MiB");
  let artifactManifest;
  try { artifactManifest = JSON.parse(readZipEntry(buf, manifestEntry, label).toString("utf8")); }
  catch (error) {
    if (error.message.startsWith("ERROR:")) throw error;
    artifactError(label, `invalid plugin.json in release ZIP: ${error.message}`);
  }
  if (!isDeepStrictEqual(artifactManifest, sourceManifest)) {
    artifactError(label, "release plugin.json does not match the reviewed source plugin.json");
  }
  const errs = validateExecPaths(artifactManifest, (rel) => entries.has(rel) && !entries.get(rel).directory);
  if (errs.length) artifactError(label, errs.join("; "));
  const executable = artifactManifest.exec[0];
  if (executable.startsWith("./")) {
    const rel = posix.normalize(executable).replace(/^\.\//, "");
    if ((entries.get(rel).mode & 0o111) === 0) artifactError(label, `exec entry is not executable: ${executable}`);
  }
}

function verifyLocalRelease(rest) {
  const sourceDir = rest[0];
  const zipPath = rest[1];
  if (!sourceDir || !zipPath) die("usage: plugins verify-release <plugin-dir> <archive.zip>");
  const manifest = readManifest(sourceDir);
  const buf = readFileSync(zipPath);
  verifyReleaseZip(buf, manifest, `${manifest.name} ${manifest.version}`);
  const sha = createHash("sha256").update(buf).digest("hex");
  console.log(`Verified ${zipPath}\nsha256 ${sha}`);
}

async function lockPlugin(dir, lock) {
  const manifest = readManifest(dir);
  const release = releaseInfo(dir, manifest);
  console.log(`Fetching ${manifest.name} ${manifest.version} from ${release.url}`);
  const buf = await download(release.url, `${manifest.name} ${manifest.version}`);
  verifyReleaseZip(buf, manifest, `${manifest.name} ${manifest.version}`);
  lock.plugins[manifest.name] = {
    version: manifest.version,
    tag: release.tag,
    commit: captureOr(["rev-parse", "HEAD"], dir),
    artifact: release.artifact,
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
  };
  console.log(`Locked ${manifest.name} ${manifest.version}`);
}

async function lockPlugins(rest) {
  const target = rest[0];
  if (!target) die("usage: plugins lock <name>|--all");
  const dirs = target === "--all"
    ? pluginDirs()
    : [join(PLUGINS_DIR, target)];
  if (target !== "--all" && (!existsSync(dirs[0]) || !existsSync(join(dirs[0], "plugin.json")))) {
    die(`ERROR: no plugin '${target}'`);
  }
  const lock = readLock();
  for (const dir of dirs) await lockPlugin(dir, lock);
  const active = new Set(pluginDirs().map((dir) => basename(dir)));
  for (const name of Object.keys(lock.plugins)) if (!active.has(name)) delete lock.plugins[name];
  writeLock(lock);
  console.log(`Wrote ${LOCK_PATH}`);
}

async function pkg() {
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) die("ERROR: missing PUBLIC_BASE_URL");
  const basePath = (process.env.PLUGINS_PREFIX || "plugins").replace(/^\/+|\/+$/g, "");
  const out = process.env.PLUGINS_DIST || join(ROOT, "dist", "plugins");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const plugins = [];
  const lock = readLock();
  for (const dir of pluginDirs()) {
    const m = readManifest(dir);
    const name = m.name || "";
    const version = m.version || "0.0.0";
    if (!SAFE_NAME.test(name)) die(`ERROR: unsafe name '${name}' in ${dir}`);
    const destDir = join(out, name, version);
    mkdirSync(destDir, { recursive: true });
    const zipPath = join(destDir, `${name}.zip`);
    const release = releaseInfo(dir, m);
    const pinned = lock.plugins[name];
    const commit = captureOr(["rev-parse", "HEAD"], dir);
    if (!pinned) die(`ERROR: ${name}: missing plugins.lock.json entry (run 'node scripts/plugins.mjs lock ${name}')`);
    for (const [field, actual] of Object.entries({ version, tag: release.tag, commit, artifact: release.artifact })) {
      if (pinned[field] !== actual) die(`ERROR: ${name}: lock ${field} '${pinned[field] || ""}' != reviewed '${actual}' (refresh the lock)`);
    }
    console.log(`Fetching ${name} ${version} from ${release.url}`);
    const buf = await download(release.url, `${name} ${version}`);
    verifyReleaseZip(buf, m, `${name} ${version}`);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (pinned.sha256 !== sha || pinned.size !== buf.length) {
      die(`ERROR: ${name}: release asset bytes changed after approval (lock ${pinned.sha256}/${pinned.size}, download ${sha}/${buf.length})`);
    }
    writeFileSync(zipPath, buf);
    writeFileSync(`${zipPath}.sha256`, `${sha}  ${name}.zip\n`);
    plugins.push({
      name, version,
      protocol: m.protocol || 1,
      description: m.description || "",
      capabilities: m.capabilities || {},
      platforms: m.platforms || ["macos", "linux", "windows"],
      archive: { url: `${baseUrl}/${basePath}/${name}/${version}/${name}.zip`, sha256: sha, size: buf.length },
      publisher: m.publisher || "Commander",
      homepage: m.homepage || "",
      license: m.license || "",
    });
    console.log(`Verified and copied ${name} ${version}`);
  }
  const indexPath = join(out, "index.json");
  writeFileSync(indexPath, `${JSON.stringify({ schema: 1, updated: new Date().toISOString(), plugins })}\n`);
  console.log(`Wrote ${indexPath} (${plugins.length} plugin(s))`);
  return out;
}

async function deploy() {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) die("ERROR: missing STORAGE_BUCKET");
  const out = await pkg();
  const prefix = (process.env.PLUGINS_PREFIX || "plugins").replace(/^\/+|\/+$/g, "");
  const region = process.env.AWS_REGION || "auto";
  const endpoint = process.env.STORAGE_ENDPOINT_URL;
  const args = [];
  if (endpoint) args.push("--endpoint-url", endpoint);
  args.push("--region", region, "s3", "sync", `${out}${sep}`, `s3://${bucket}/${prefix}/`,
    "--delete", "--exclude", "*", "--include", "index.json", "--include", "*.zip", "--include", "*.zip.sha256");
  execFileSync("aws", args, { stdio: "inherit" });
  console.log(`Deployed plugin catalog to s3://${bucket}/${prefix}/`);
  const publicBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (publicBase) console.log(`Public catalog: ${publicBase}/${prefix}/index.json`);
}

// ---- versioning note -----------------------------------------------------

function versionNote(dir) {
  let ver = "";
  try { ver = readManifest(dir).version || ""; } catch {}
  const tag = captureOr(["describe", "--exact-match", "--tags", "HEAD"], dir, "");
  if (!tag) {
    console.error("NOTE: pinned commit is not at a release tag. Prefer pinning to vX.Y.Z so");
    console.error(`      the catalog path plugins/<name>/${ver}/ maps to a tagged release.`);
  } else if (tag.replace(/^v/, "") !== ver) {
    console.error(`NOTE: tag '${tag}' does not match plugin.json version '${ver}'.`);
    console.error("      Keep them in sync (tag vX.Y.Z <-> version X.Y.Z).");
  }
}

// ---- submodule management ------------------------------------------------

function splitRef(rest) {
  let ref = "";
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ref") ref = rest[++i] || "";
    else pos.push(rest[i]);
  }
  return { ref, pos };
}

// Clone <url> into a throwaway shallow dir just to read plugin.json's "name", so
// `add` can create the submodule directly at plugins/<manifest-name>: one clean
// `submodule add`, no post-hoc rename, and no leftover .git/modules storage or
// 'commander-plugin-*' section to clean up later. Returns "" if the probe fails.
function discoverManifestName(url) {
  const slug = basename(url).replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  const tmp = join(ROOT, ".git", `plugin-probe-${slug}`);
  rmSync(tmp, { recursive: true, force: true });
  let name = "";
  try {
    captureOr(["clone", "--quiet", "--depth", "1", url, tmp]);
    name = readManifest(tmp).name || "";
  } catch { name = ""; }
  rmSync(tmp, { recursive: true, force: true });
  return name;
}

async function add(rest) {
  const { ref, pos } = splitRef(rest);
  const url = pos[0];
  let name = pos[1] || "";
  if (!url) die("usage: plugins add <git-url> [name] [--ref <ref>]");
  if (!SAFE_URL.test(url)) die(`ERROR: refusing non-https/ssh git url: ${url}`);
  // Default the dir to plugin.json's "name" (probed from a throwaway clone), not
  // the repo/url basename: repos are usually 'commander-plugin-<x>' while the
  // manifest name is just '<x>', and validate() requires dir == manifest name.
  if (!name) name = discoverManifestName(url) || basename(url).replace(/\.git$/, "");
  if (!SAFE_NAME.test(name)) die(`ERROR: unsafe plugin name '${name}'`);

  const rel = `plugins/${name}`;
  const dest = join(ROOT, rel);
  if (existsSync(dest)) die(`ERROR: ${rel} already exists (use 'update' to re-pin)`);

  // A previous interrupted add can leave an orphaned git dir under .git/modules
  // that makes `submodule add` refuse. If nothing references it, drop it so the
  // add is retry-safe.
  const orphan = join(ROOT, ".git", "modules", rel);
  if (existsSync(orphan) && !isRegistered(rel)) {
    console.log(`Removing orphaned git dir from a previous attempt: .git/modules/${rel}`);
    rmSync(orphan, { recursive: true, force: true });
  }

  console.log(`Adding submodule ${url} -> ${rel}`);
  run(["submodule", "add", url, rel]);
  run(["submodule", "update", "--init", rel]);
  if (ref) checkoutRef(dest, ref);

  // Without an explicit name the dir already matches the manifest (probed above).
  // With one, guard the case where it disagrees — validate() requires dir ==
  // manifest name, so surface it clearly instead of failing cryptically.
  try {
    const real = readManifest(dest).name || "";
    if (real && real !== name) {
      console.error(`NOTE: plugin.json name is '${real}' but you added it as '${name}'.`);
      console.error(`      Omit the name argument (it defaults to the manifest name), or re-add as '${real}'.`);
    }
  } catch {}

  console.log("\nValidating…");
  validate();
  console.log(`\nPinned commit:\n${captureOr(["rev-parse", "HEAD"], dest)}`);
  versionNote(dest);
  console.log("\nLocking release artifact…");
  await lockPlugins([name]);
  run(["add", "--", "plugins.lock.json"]);
  console.log(`\nNext:\n  git commit -m 'add ${name} plugin'   # then push your fork and open a PR`);
}

async function update(rest) {
  const { ref, pos } = splitRef(rest);
  const target = pos[0];
  if (!target) die("usage: plugins update <name>|--all [--ref <ref>]");

  const repin = (name) => {
    const rel = `plugins/${name}`;
    const dest = join(ROOT, rel);
    console.log(`== ${rel} ==`);
    if (ref) {
      checkoutRef(dest, ref);
    } else {
      try { run(["fetch", "--tags", "origin"], dest); } catch {}
      run(["submodule", "update", "--remote", "--checkout", rel]);
    }
    console.log(captureOr(["rev-parse", "HEAD"], dest));
    versionNote(dest);
  };

  if (target === "--all") {
    for (const dir of pluginDirs()) repin(basename(dir));
  } else {
    if (!existsSync(join(ROOT, "plugins", target))) die(`ERROR: no plugin '${target}'`);
    repin(target);
  }
  console.log("\nValidating…");
  validate();
  console.log("\nLocking release artifact…");
  await lockPlugins(target === "--all" ? ["--all"] : [target]);
  console.log("\nReview the pinned-commit change with 'git diff', then commit + open a PR.");
}

function remove(rest) {
  const name = rest[0];
  if (!name) die("usage: plugins remove <name>");
  if (!SAFE_NAME.test(name)) die(`ERROR: unsafe plugin name '${name}'`);
  const rel = `plugins/${name}`;
  const dest = join(ROOT, rel);
  if (!existsSync(dest)) die(`ERROR: no plugin at ${rel}`);
  const modules = join(ROOT, ".git", "modules", "plugins", name);

  if (isRegistered(rel)) {
    // A properly-registered submodule: let git unwire it — deinit clears the
    // submodule.<name> section in .git/config, `git rm` drops the gitlink and
    // the .gitmodules entry.
    run(["submodule", "deinit", "-f", rel]);
    run(["rm", "-f", rel]);
    rmSync(modules, { recursive: true, force: true });
    const lock = readLock();
    delete lock.plugins[name];
    writeLock(lock);
    console.log(`\nRemoved ${rel}. Commit + open a PR (deploy prunes it from storage).`);
  } else {
    // An orphaned leftover from an interrupted `add` (present on disk but absent
    // from .gitmodules and the index): `git submodule deinit` would abort with a
    // pathspec error, so tear it down by hand — worktree, git storage, and any
    // stale submodule.<name> section left behind in .git/config.
    console.log(`plugins/${name} is not a registered submodule; cleaning up orphaned leftovers.`);
    rmSync(dest, { recursive: true, force: true });
    rmSync(modules, { recursive: true, force: true });
    captureOr(["config", "--remove-section", `submodule.${rel}`]);
    console.log(`\nRemoved orphaned ${rel} (nothing to commit — it was never tracked).`);
  }
}

// ---- dispatch ------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "validate": validate(); break;
      case "verify-release": verifyLocalRelease(rest); break;
      case "lock": await lockPlugins(rest); break;
      case "package": await pkg(); break;
      case "deploy": await deploy(); break;
      case "add": await add(rest); break;
      case "update": await update(rest); break;
      case "remove": remove(rest); break;
      default:
        console.error("usage: plugins <validate|verify-release|lock|add|update|remove|package|deploy> [args]");
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { githubRepoUrl, verifyReleaseZip, zipEntries };
