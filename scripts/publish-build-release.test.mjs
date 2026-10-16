import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectInstallers,
  expectedArtifacts,
  publishBuildRelease,
} from "./publish-build-release.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "handy-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [artifact, extensions] of Object.entries(expectedArtifacts)) {
    await mkdir(join(directory, artifact, "bundle"), { recursive: true });
    for (const extension of extensions) {
      await writeFile(
        join(directory, artifact, "bundle", `${artifact}${extension}`),
        "installer",
      );
    }
  }
  return directory;
}

function api(existing, failUpload = false) {
  const calls = [];
  const repos = {};
  for (const name of [
    "getReleaseByTag",
    "createRelease",
    "listReleaseAssets",
    "deleteReleaseAsset",
    "uploadReleaseAsset",
    "updateRelease",
  ]) {
    repos[name] = async (args) => {
      calls.push({ name, args });
      if (name === "getReleaseByTag") {
        if (existing) return { data: existing };
        throw Object.assign(new Error("Not found"), { status: 404 });
      }
      if (name === "uploadReleaseAsset" && failUpload)
        throw new Error("Upload failed");
      return { data: { id: 42, html_url: "https://example.test/release" } };
    };
  }
  return {
    calls,
    github: {
      rest: {
        repos,
        git: {
          getRef: async () => {
            throw Object.assign(new Error("Not found"), { status: 404 });
          },
          createRef: async () => ({}),
        },
      },
      paginate: async () => existing?.assets ?? [],
    },
  };
}

const context = {
  ref: "refs/heads/main",
  eventName: "push",
  sha: "a".repeat(40),
  runNumber: 12,
  runId: 123,
  serverUrl: "https://github.com",
  repo: { owner: "m407", repo: "Handy" },
};

test("publishes all platform installers only after all uploads, pinned to the built commit", async (t) => {
  const directory = await fixture(t);
  const { github, calls } = api();
  await publishBuildRelease({ github, context, directory, version: "0.9.8" });
  assert.equal(calls[1].args.target_commitish, context.sha);
  assert.equal(calls[1].args.draft, true);
  assert.equal(calls[1].args.tag_name, "v0.9.8");
  assert.equal(calls.filter((c) => c.name === "uploadReleaseAsset").length, 10);
  assert.equal(calls.at(-1).name, "updateRelease");
  assert.equal(calls.at(-1).args.draft, false);
});

test("missing platform or package format prevents any GitHub mutation", async (t) => {
  const directory = await fixture(t);
  const artifact = "handy-ubuntu-24.04-arm-aarch64-unknown-linux-gnu";
  await rm(join(directory, artifact, "bundle", `${artifact}.rpm`));
  const { github, calls } = api();
  await assert.rejects(
    publishBuildRelease({ github, context, directory, version: "0.9.8" }),
    /Missing .rpm/,
  );
  assert.equal(calls.length, 0);
});

test("duplicate asset filenames are rejected", async (t) => {
  const directory = await fixture(t);
  for (const artifact of Object.keys(expectedArtifacts).slice(0, 2)) {
    await writeFile(join(directory, artifact, "duplicate.dmg"), "installer");
  }
  await assert.rejects(collectInstallers(directory), /Duplicate/);
});

test("upload failure leaves the release as a draft", async (t) => {
  const directory = await fixture(t);
  const { github, calls } = api(undefined, true);
  await assert.rejects(
    publishBuildRelease({ github, context, directory, version: "0.9.8" }),
    /Upload failed/,
  );
  assert.ok(!calls.some((c) => c.name === "updateRelease"));
});

test("retry resumes a draft and replaces a partial upload", async (t) => {
  const directory = await fixture(t);
  const { github, calls } = api({
    id: 42,
    draft: true,
    target_commitish: context.sha,
    assets: [{ id: 9, name: "handy-aarch64-apple-darwin.dmg" }],
  });
  await publishBuildRelease({ github, context, directory, version: "0.9.8" });
  assert.ok(!calls.some((c) => c.name === "createRelease"));
  assert.equal(calls[1].name, "deleteReleaseAsset");
  assert.equal(calls.at(-1).name, "updateRelease");
});

test("successful rerun does not modify a published release", async (t) => {
  const directory = await fixture(t);
  const { github, calls } = api({
    draft: false,
    target_commitish: context.sha,
    html_url: "release",
  });
  assert.equal(
    await publishBuildRelease({ github, context, directory, version: "0.9.8" }),
    "release",
  );
  assert.equal(calls.length, 1);
});

test("PR events and non-main manual builds cannot publish", async () => {
  for (const override of [
    { eventName: "pull_request" },
    { ref: "refs/heads/feature", eventName: "workflow_dispatch" },
  ]) {
    const { github, calls } = api();
    await assert.rejects(
      publishBuildRelease({ github, context: { ...context, ...override } }),
      /Only main/,
    );
    assert.equal(calls.length, 0);
  }
});

test("prerelease tags publish a prerelease without replacing Latest", async (t) => {
  const directory = await fixture(t);
  const { github, calls } = api();
  await publishBuildRelease({
    github,
    directory,
    version: "1.0.0-beta.1",
    context: { ...context, ref: "refs/tags/v1.0.0-beta.1" },
  });
  assert.equal(calls[1].args.prerelease, true);
  assert.equal(calls.at(-1).args.make_latest, "false");
});

test("annotated tags are resolved to their commit", async (t) => {
  const directory = await fixture(t);
  const { github } = api();
  github.rest.git.getRef = async () => ({
    data: { object: { type: "tag", sha: "tag-object" } },
  });
  github.rest.git.getTag = async () => ({
    data: { object: { type: "commit", sha: context.sha } },
  });
  await publishBuildRelease({ github, context, directory, version: "0.9.8" });
  github.rest.git.getTag = async () => ({
    data: { object: { type: "commit", sha: "different" } },
  });
  await assert.rejects(
    publishBuildRelease({ github, context, directory, version: "0.9.8" }),
    /different commit/,
  );
});
