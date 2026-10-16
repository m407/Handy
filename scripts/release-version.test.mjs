import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyVersion,
  nextReleaseVersion,
  parseVersion,
} from "./release-version.mjs";

test("SemVer validates stable and prerelease versions", () => {
  for (const version of ["0.9.8", "1.0.0-beta.1", "2.1.0+build.42"])
    assert.equal(parseVersion(version).version, version);
  for (const version of [
    "v1.0.0",
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3\n",
  ])
    assert.throws(() => parseVersion(version));
});

test("allocates the next patch using numeric ordering of Git tags", () => {
  assert.equal(
    nextReleaseVersion(
      ["v0.9.9", "v0.9.10", "v1.0.0-beta.1", "other"],
      [],
      "0.9.8",
    ),
    "0.9.11",
  );
  assert.equal(nextReleaseVersion([], [], "0.9.8"), "0.9.9");
  assert.equal(nextReleaseVersion(["v0.9.99"], [], "1.0.0"), "1.0.1");
});

test("a rerun preserves the tag assigned to the same commit", () => {
  assert.equal(
    nextReleaseVersion(["v0.9.9", "v0.9.10"], ["v0.9.9"], "0.9.8"),
    "0.9.9",
  );
});

test("updates Tauri, npm, Cargo manifest and only Handy's lockfile entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handy-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src-tauri"));
  for (const file of ["package.json", "src-tauri/tauri.conf.json"])
    await writeFile(join(root, file), '{"version":"0.9.8"}');
  await writeFile(
    join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "handy"\nversion = "0.9.8"\n',
  );
  await writeFile(
    join(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "handy"\nversion = "0.9.8"\n\n[[package]]\nname = "dependency"\nversion = "0.9.8"\n',
  );
  await applyVersion(root, "1.2.3");
  for (const file of ["package.json", "src-tauri/tauri.conf.json"])
    assert.equal(JSON.parse(await readFile(join(root, file))).version, "1.2.3");
  assert.match(
    await readFile(join(root, "src-tauri/Cargo.toml"), "utf8"),
    /version = "1.2.3"/,
  );
  const lock = await readFile(join(root, "src-tauri/Cargo.lock"), "utf8");
  assert.match(lock, /name = "handy"\nversion = "1.2.3"/);
  assert.match(lock, /name = "dependency"\nversion = "0.9.8"/);
  await applyVersion(root, "1.2.3-beta.1");
  const config = JSON.parse(
    await readFile(join(root, "src-tauri/tauri.conf.json")),
  );
  assert.equal(config.version, "1.2.3-beta.1");
  assert.equal(config.bundle.windows.wix.version, "1.2.3.0");
  await assert.rejects(applyVersion(root, "256.0.0"), /Windows MSI limits/);
});

test("Windows CRLF manifests and lockfiles retain their line endings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handy-version-crlf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src-tauri"));
  for (const file of ["package.json", "src-tauri/tauri.conf.json"])
    await writeFile(join(root, file), '{"version":"0.9.8"}');
  const manifest = '[package]\r\nname = "handy"\r\nversion = "0.9.8"\r\n';
  const lock = '[[package]]\r\nname = "handy"\r\nversion = "0.9.8"\r\n';
  await writeFile(join(root, "src-tauri/Cargo.toml"), manifest);
  await writeFile(join(root, "src-tauri/Cargo.lock"), lock);
  await applyVersion(root, "0.9.9");
  assert.equal(
    await readFile(join(root, "src-tauri/Cargo.toml"), "utf8"),
    manifest.replace("0.9.8", "0.9.9"),
  );
  assert.equal(
    await readFile(join(root, "src-tauri/Cargo.lock"), "utf8"),
    lock.replace("0.9.8", "0.9.9"),
  );
});
