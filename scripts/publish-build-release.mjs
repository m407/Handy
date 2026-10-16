import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseVersion } from "./release-version.mjs";

export const expectedArtifacts = {
  "handy-aarch64-apple-darwin": [".dmg"],
  "handy-x86_64-apple-darwin": [".dmg"],
  "handy-ubuntu-22.04-x86_64-unknown-linux-gnu": [".deb"],
  "handy-ubuntu-24.04-x86_64-unknown-linux-gnu": [".AppImage", ".rpm"],
  "handy-ubuntu-24.04-arm-aarch64-unknown-linux-gnu": [
    ".AppImage",
    ".deb",
    ".rpm",
  ],
  "handy-x86_64-pc-windows-msvc": [".exe"],
  "handy-aarch64-pc-windows-msvc": [".exe"],
};

async function installers(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      files.push(...(await installers(path)));
    } else if (
      entry.isFile() &&
      /\.(dmg|deb|rpm|AppImage|exe|msi)$/.test(entry.name)
    ) {
      if ((await stat(path)).size === 0)
        throw new Error(`Empty installer: ${path}`);
      files.push(path);
    }
  }
  return files;
}

export async function collectInstallers(directory) {
  const files = [];
  for (const [artifact, extensions] of Object.entries(expectedArtifacts)) {
    const found = await installers(join(directory, artifact));
    for (const extension of extensions) {
      if (!found.some((file) => file.endsWith(extension))) {
        throw new Error(`Missing ${extension} installer in ${artifact}`);
      }
    }
    files.push(...found);
  }
  const names = files.map((file) => basename(file));
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate installer names");
  return files;
}

export async function publishBuildRelease({
  github,
  context,
  directory,
  version,
}) {
  const mainBuild =
    context.ref === "refs/heads/main" &&
    ["push", "workflow_dispatch"].includes(context.eventName);
  const tagBuild =
    context.ref === `refs/tags/v${version}` && context.eventName === "push";
  if (!mainBuild && !tagBuild) {
    throw new Error("Only main or SemVer tag builds can publish releases");
  }
  // Validate the complete matrix before creating a release or uploading anything.
  const files = await collectInstallers(directory);
  const repo = context.repo;
  const { prerelease } = parseVersion(version);
  const tag = `v${version}`;
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({
      ...repo,
      tag,
    }));
  } catch (error) {
    if (error.status !== 404) throw error;
    // Tag lookup is for published releases; list also includes drafts visible
    // to this token, including a release interrupted during asset uploads.
    const releases = await github.paginate(
      github.rest.repos.listReleases,
      repo,
    );
    release = releases.find((candidate) => candidate.tag_name === tag);
  }
  if (release && release.target_commitish !== context.sha) {
    throw new Error("Existing release points to a different commit");
  }
  // Re-running a successful workflow must not modify published assets.
  if (release && !release.draft) return release.html_url;
  // Reserve the version on the built commit, including if an upload later fails.
  // A rerun of that commit reuses the tag; a new commit gets the next patch.
  try {
    const { data } = await github.rest.git.getRef({
      ...repo,
      ref: `tags/${tag}`,
    });
    let object = data.object;
    while (object.type === "tag") {
      const { data: tagObject } = await github.rest.git.getTag({
        ...repo,
        tag_sha: object.sha,
      });
      object = tagObject.object;
    }
    if (object.sha !== context.sha)
      throw new Error("Release tag points to a different commit");
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({
      ...repo,
      ref: `refs/tags/${tag}`,
      sha: context.sha,
    });
  }
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({
      ...repo,
      tag_name: tag,
      target_commitish: context.sha,
      name: `Handy ${tag}`,
      body: `Unsigned installers from commit ${context.sha}.\n\n[Build and checks](${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}). Automatic updates are disabled in these builds.`,
      draft: true,
      prerelease: Boolean(prerelease),
    }));
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
  });
  for (const file of files) {
    const name = basename(file);
    const existing = assets.find((asset) => asset.name === name);
    if (existing) {
      await github.rest.repos.deleteReleaseAsset({
        ...repo,
        asset_id: existing.id,
      });
    }
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name,
      data: await readFile(file),
    });
  }
  const { data } = await github.rest.repos.updateRelease({
    ...repo,
    release_id: release.id,
    draft: false,
    make_latest: prerelease ? "false" : "legacy",
  });
  return data.html_url;
}
