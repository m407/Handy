import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./configure-ci-build.mjs", import.meta.url).href;
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
function run(env, platform = "linux") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handy-ci-config-"));
  try {
    fs.mkdirSync(path.join(cwd, "src-tauri"));
    const configPath = path.join(cwd, "src-tauri/tauri.conf.json");
    fs.writeFileSync(configPath, JSON.stringify(fixture));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); await import(${JSON.stringify(script)});`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          SIGN_BINARIES: "false",
          UPDATER_PUBLIC_KEY: "",
          WINDOWS_SIGN_COMMAND: "",
          BUILD_SERVER_URL: "https://github.com",
          BUILD_REPOSITORY: "m407/Handy",
          ...env,
        },
        encoding: "utf8",
      },
    );
    return {
      ...result,
      config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("unsigned fork artifacts cannot use upstream signing or updater configuration", () => {
  const { status, stderr, config } = run({});
  assert.equal(status, 0, stderr);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.signCommand, undefined);
  assert.deepEqual(config.bundle.windows.nsis, fixture.bundle.windows.nsis);
  assert.deepEqual(config.plugins.updater.endpoints, []);
  assert.equal(config.plugins.updater.pubkey, "");
});

test("signed builds use the destination repository and its own public key", () => {
  const { status, stderr, config } = run({
    SIGN_BINARIES: "true",
    UPDATER_PUBLIC_KEY: "fork-public-key",
  });
  assert.equal(status, 0, stderr);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/m407/Handy/releases/latest/download/latest.json",
  ]);
  assert.equal(config.plugins.updater.pubkey, "fork-public-key");
});

test("signed builds without an owned public key fail without modifying config", () => {
  const { status, config, stderr } = run({ SIGN_BINARIES: "true" });
  assert.notEqual(status, 0);
  assert.match(stderr, /require TAURI_SIGNING_PUBLIC_KEY/);
  assert.deepEqual(config, fixture);
});

test("signed Windows builds require and use an owned signing command", () => {
  const env = { SIGN_BINARIES: "true", UPDATER_PUBLIC_KEY: "fork-public-key" };
  const missing = run(env, "win32");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /require WINDOWS_SIGN_COMMAND/);
  const command = "trusted-signing-cli -a ForkAccount -c ForkProfile %1";
  const signed = run({ ...env, WINDOWS_SIGN_COMMAND: command }, "win32");
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(signed.config.bundle.windows.signCommand, command);
});

test("missing repository is rejected before writing config", () => {
  const result = run({ BUILD_REPOSITORY: "" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.config, fixture);
});
