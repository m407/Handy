// CI-only overrides: never publish a fork with upstream signing identities or updater trust.
import fs from "node:fs";

const configPath = "src-tauri/tauri.conf.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const signed = process.env.SIGN_BINARIES === "true";
const repository = process.env.BUILD_REPOSITORY;
const serverUrl = process.env.BUILD_SERVER_URL || "https://github.com";
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error(
    "BUILD_REPOSITORY must identify the destination owner/repository",
  );
}

config.bundle.createUpdaterArtifacts = signed;
config.bundle.windows ??= {};
delete config.bundle.windows.signCommand;
config.plugins ??= {};
if (signed) {
  const publicKey = process.env.UPDATER_PUBLIC_KEY;
  if (!publicKey)
    throw new Error("Signed releases require TAURI_SIGNING_PUBLIC_KEY");
  config.plugins.updater = {
    ...config.plugins.updater,
    pubkey: publicKey,
    endpoints: [
      `${serverUrl}/${repository}/releases/latest/download/latest.json`,
    ],
  };
  if (process.platform === "win32") {
    const command = process.env.WINDOWS_SIGN_COMMAND;
    if (!command)
      throw new Error("Signed Windows releases require WINDOWS_SIGN_COMMAND");
    config.bundle.windows.signCommand = command;
  }
} else {
  // No updater feed is advertised until the fork has its own signing key.
  config.plugins.updater = {
    ...config.plugins.updater,
    pubkey: "",
    endpoints: [],
  };
}
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
