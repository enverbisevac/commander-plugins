import assert from "node:assert/strict";
import test from "node:test";

import { githubRepoUrl, verifyReleaseZip, zipEntries } from "./plugins.mjs";

function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, value] of Object.entries(files)) {
    const spec = typeof value === "string" ? { content: value, mode: 0o644 } : value;
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(spec.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    local.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE((((0o100000 | spec.mode) << 16) >>> 0), 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const manifest = {
  name: "example-viewer",
  version: "1.2.3",
  protocol: 1,
  exec: ["python3", "./viewer.py"],
  capabilities: { viewer: { extensions: ["example"] } },
};

test("normalizes supported GitHub clone URLs", () => {
  assert.equal(githubRepoUrl("https://github.com/acme/plugin.git"), "https://github.com/acme/plugin");
  assert.equal(githubRepoUrl("git@github.com:acme/plugin.git"), "https://github.com/acme/plugin");
  assert.equal(githubRepoUrl("ssh://git@github.com/acme/plugin"), "https://github.com/acme/plugin");
  assert.equal(githubRepoUrl("https://example.com/acme/plugin.git"), "");
});

test("accepts a release ZIP whose manifest and exec paths match source", () => {
  const zip = makeZip({
    "plugin.json": JSON.stringify(manifest),
    "viewer.py": "print('ok')\n",
  });
  assert.doesNotThrow(() => verifyReleaseZip(zip, manifest, "fixture"));
  assert.deepEqual([...zipEntries(zip, "fixture").keys()], ["plugin.json", "viewer.py"]);
});

test("rejects a release manifest that differs from reviewed source", () => {
  const changed = { ...manifest, exec: ["python3", "./payload.py"] };
  const zip = makeZip({
    "plugin.json": JSON.stringify(changed),
    "payload.py": "print('unexpected')\n",
  });
  assert.throws(() => verifyReleaseZip(zip, manifest, "fixture"), /does not match the reviewed source/);
});

test("rejects unsafe ZIP paths", () => {
  const zip = makeZip({
    "plugin.json": JSON.stringify(manifest),
    "viewer.py": "print('ok')\n",
    "../escape": "bad",
  });
  assert.throws(() => verifyReleaseZip(zip, manifest, "fixture"), /unsafe ZIP path/);
});

test("requires a relative entrypoint to retain its executable mode", () => {
  const binaryManifest = { ...manifest, exec: ["./viewer"] };
  const zip = makeZip({
    "plugin.json": JSON.stringify(binaryManifest),
    "viewer": { content: "binary", mode: 0o644 },
  });
  assert.throws(() => verifyReleaseZip(zip, binaryManifest, "fixture"), /is not executable/);
});
