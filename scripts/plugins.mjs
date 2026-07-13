#!/usr/bin/env node
//
// Cross-platform plugin-catalog toolchain (macOS / Linux / Windows). Uses only
// Node built-ins + `git`; `deploy` additionally shells out to the `aws` CLI.
// No bash / zip / shasum / awk, so a plugin developer on any OS can add and
// validate a plugin, and CI builds the catalog the same way.
//
// Commands:
//   node scripts/plugins.mjs validate
//   node scripts/plugins.mjs add <git-url> [name] [--ref <branch-or-tag-or-sha>]
//   node scripts/plugins.mjs update <name>|--all [--ref <ref>]
//   node scripts/plugins.mjs remove <name>
//   node scripts/plugins.mjs package        # build dist/plugins/ (needs PUBLIC_BASE_URL)
//   node scripts/plugins.mjs deploy         # package + sync to the object store
//
// (npm run aliases exist: `npm run validate`, `npm run add -- <url> <name>`, …)

import {
  readFileSync, writeFileSync, readdirSync, statSync, lstatSync,
  mkdirSync, rmSync, existsSync,
} from "node:fs";
import { join, basename, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = process.env.PLUGINS_SRC || join(ROOT, "plugins");

const SAFE_NAME = /^[A-Za-z0-9._-]{1,96}$/;
const SAFE_PATH = /^plugins\/[A-Za-z0-9._-]{1,96}$/;
const SAFE_URL = /^(https:\/\/|ssh:\/\/|git@)/;
const KNOWN_CAPS = ["viewer", "thumbnail", "packer", "fs", "converter"];
const ZIP_EXCLUDE = new Set([".git", ".github", ".gitignore", ".gitmodules", ".DS_Store"]);

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
    if (!m.version) errs.push("missing version");
    const proto = m.protocol == null ? 1 : m.protocol;
    if (typeof proto !== "number" || proto > 1) errs.push(`unsupported protocol ${proto} (max 1)`);
    if (!Array.isArray(m.exec) || m.exec.length === 0) errs.push("missing/empty exec array");
    const caps = Object.keys(m.capabilities || {}).filter((k) => KNOWN_CAPS.includes(k));
    if (caps.length === 0) errs.push("no known capability (viewer/thumbnail/packer/fs/converter)");
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

// ---- packaging (hand-rolled zip, no external tools) ----------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (ZIP_EXCLUDE.has(name)) continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(full, base, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

// Build a standard ZIP (STORE or raw-DEFLATE per entry) with a fixed 1980
// timestamp so identical inputs yield an identical archive (stable sha256).
// Unix mode rides in the external attributes so the exec bit survives extract.
function zipDir(dir) {
  const MODTIME = 0, MODDATE = 0x0021; // 1980-01-01
  const files = walkFiles(dir);
  const local = [];
  const central = [];
  let offset = 0;
  for (const full of files) {
    const rel = full.slice(dir.length + 1).split(sep).join("/");
    const nameBuf = Buffer.from(rel, "utf8");
    const raw = readFileSync(full);
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const data = useDeflate ? deflated : raw;
    const mode = (statSync(full).mode & 0o7777) || 0o644;
    const externalAttrs = (((0o100000 | mode) << 16) >>> 0);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(MODTIME, 10);
    lh.writeUInt16LE(MODDATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // version made by: unix, spec 2.0 (so mode is read)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(MODTIME, 12);
    cd.writeUInt16LE(MODDATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(externalAttrs, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

function pkg() {
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) die("ERROR: missing PUBLIC_BASE_URL");
  const basePath = (process.env.PLUGINS_PREFIX || "plugins").replace(/^\/+|\/+$/g, "");
  const out = process.env.PLUGINS_DIST || join(ROOT, "dist", "plugins");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const plugins = [];
  for (const dir of pluginDirs()) {
    const m = readManifest(dir);
    const name = m.name || "";
    const version = m.version || "0.0.0";
    if (!SAFE_NAME.test(name)) die(`ERROR: unsafe name '${name}' in ${dir}`);
    const destDir = join(out, name, version);
    mkdirSync(destDir, { recursive: true });
    const zipPath = join(destDir, `${name}.zip`);
    const buf = zipDir(dir);
    writeFileSync(zipPath, buf);
    const sha = createHash("sha256").update(buf).digest("hex");
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
    console.log(`Packaged ${name} ${version}`);
  }
  const indexPath = join(out, "index.json");
  writeFileSync(indexPath, `${JSON.stringify({ schema: 1, updated: new Date().toISOString(), plugins })}\n`);
  console.log(`Wrote ${indexPath} (${plugins.length} plugin(s))`);
  return out;
}

function deploy() {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) die("ERROR: missing STORAGE_BUCKET");
  const out = pkg();
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

function add(rest) {
  const { ref, pos } = splitRef(rest);
  const url = pos[0];
  let name = pos[1] || "";
  if (!url) die("usage: plugins add <git-url> [name] [--ref <ref>]");
  if (!SAFE_URL.test(url)) die(`ERROR: refusing non-https/ssh git url: ${url}`);
  if (!name) name = basename(url).replace(/\.git$/, "");
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

  try {
    const real = readManifest(dest).name || "";
    if (real && real !== name) {
      console.error(`NOTE: plugin.json name is '${real}' but submodule dir is '${name}'.`);
      console.error(`      Re-add with the matching name, or: git mv ${rel} plugins/${real}`);
    }
  } catch {}

  console.log("\nValidating…");
  validate();
  console.log(`\nPinned commit:\n${captureOr(["rev-parse", "HEAD"], dest)}`);
  versionNote(dest);
  console.log(`\nNext:\n  git commit -am 'add ${name} plugin'   # then push your fork and open a PR`);
}

function update(rest) {
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
  console.log("\nReview the pinned-commit change with 'git diff', then commit + open a PR.");
}

function remove(rest) {
  const name = rest[0];
  if (!name) die("usage: plugins remove <name>");
  const rel = `plugins/${name}`;
  if (!existsSync(join(ROOT, rel))) die(`ERROR: no plugin at ${rel}`);
  run(["submodule", "deinit", "-f", rel]);
  run(["rm", "-f", rel]);
  rmSync(join(ROOT, ".git", "modules", "plugins", name), { recursive: true, force: true });
  console.log(`\nRemoved ${rel}. Commit + open a PR (deploy prunes it from storage).`);
}

// ---- dispatch ------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "validate": validate(); break;
  case "package": pkg(); break;
  case "deploy": deploy(); break;
  case "add": add(rest); break;
  case "update": update(rest); break;
  case "remove": remove(rest); break;
  default:
    console.error("usage: plugins <validate|add|update|remove|package|deploy> [args]");
    process.exit(2);
}
