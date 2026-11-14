const assert = require("node:assert/strict");
const test = require("node:test");

// The script reads the project id at module load; the fork supplies it from a repo variable.
process.env.T2CODE_EAS_PROJECT_ID = "11111111-2222-3333-4444-555555555555";

const { mergeState, readState, render } = require("./mobile-preview-comment.cjs");

const fingerprint = "c31608b37a8a2dca35ccee39cfd2ec7305042629";
const run = "https://github.com/pingdotgg/t3code/actions/runs/1";

test("the comment round-trips its state", () => {
  const state = { fingerprint, client: "", group: "8e413a0a" };
  const body = render(state, run);
  assert.deepEqual(readState(body), state);
  assert.match(
    body,
    /Building on Blacksmith \(\[run\]\(https:\/\/github\.com\/pingdotgg\/t3code\/actions\/runs\/1\)\)/,
  );
  assert.match(
    body,
    /qr\.expo\.dev\/eas-update\?appScheme=t2code-preview&projectId=[0-9a-f-]+&groupId=8e413a0a/,
  );
  assert.equal(readState("🚀 Expo continuous deployment is ready!"), null);
});

test("the build job adds the install link without losing the update", () => {
  const first = mergeState(null, { fingerprint, client: "", group: "8e413a0a" });
  const built = mergeState(first, { fingerprint, client: "https://expo.dev/a/b", group: "" });
  assert.deepEqual(built, { fingerprint, client: "https://expo.dev/a/b", group: "8e413a0a" });
  assert.match(render(built, run), /Dev client \| \[Install\]\(https:\/\/expo\.dev\/a\/b\)/);
});

test("a new fingerprint drops the old client; the same one keeps it", () => {
  const built = { fingerprint, client: "https://expo.dev/a/b", group: "old" };
  assert.deepEqual(mergeState(built, { fingerprint, client: "", group: "new" }), {
    fingerprint,
    client: "https://expo.dev/a/b",
    group: "new",
  });
  assert.deepEqual(mergeState(built, { fingerprint: "f".repeat(40), client: "", group: "new" }), {
    fingerprint: "f".repeat(40),
    client: "",
    group: "new",
  });
});

test("a build that finishes after the PR moved to another fingerprint changes nothing", () => {
  const current = { fingerprint: "f".repeat(40), client: "", group: "new" };
  assert.deepEqual(
    mergeState(current, { fingerprint, client: "https://expo.dev/a/b", group: "" }),
    current,
  );
});

test("state from the comment is always three strings", () => {
  assert.deepEqual(
    readState('<!-- mobile-preview-android {"fingerprint":5,"client":null} -->\nx'),
    {
      fingerprint: "",
      client: "",
      group: "",
    },
  );
});
