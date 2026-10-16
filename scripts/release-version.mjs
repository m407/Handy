import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// SemVer 2.0: numeric identifiers cannot have leading zeroes.
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

export function parseVersion(version) {
  const match = semver.exec(version);
  if (!match) throw new Error(`Invalid SemVer: ${version}`);
  return {
    version,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ?? "",
  };
}

export function nextReleaseVersion(tags, currentTags, fallback) {
  const stable = (tags) =>
    tags
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag))
      .map((tag) => parseVersion(tag.slice(1)))
      .sort((a, b) => {
        for (const part of ["major", "minor", "patch"]) {
          if (a[part] !== b[part]) return a[part] > b[part] ? -1 : 1;
        }
        return 0;
      });
  // A retry uses the version already assigned to this exact commit.
  const current = stable(currentTags)[0];
  if (current) return current.version;
  const latest = stable([...tags, `v${fallback}`])[0];
  if (!latest) throw new Error("No stable baseline version");
  return `${latest.major}.${latest.minor}.${latest.patch + 1n}`;
}

export async function applyVersion(directory, version) {
  parseVersion(version);
  const updates = [];
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const path = join(directory, file);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.version = version;
    updates.push([path, `${JSON.stringify(data, null, 2)}\n`]);
  }
  for (const [file, pattern] of [
    ["src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/],
    [
      "src-tauri/Cargo.lock",
      /(\[\[package\]\]\nname = "handy"\nversion = ")[^"]+("\n)/,
    ],
  ]) {
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    if (!pattern.test(source))
      throw new Error(`Cannot locate Handy version in ${file}`);
    updates.push([
      path,
      source.replace(
        pattern,
        (_, before, after) => `${before}${version}${after}`,
      ),
    ]);
  }
  for (const [path, content] of updates) await writeFile(path, content);
}
