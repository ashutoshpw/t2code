const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}. Use the preview channel for branch builds.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

async function listNightlies({ github, context }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  return releases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function findLatestNightly(options) {
  return (await listNightlies(options))[0];
}

async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const lastNightly = await findLatestNightly({ github, context });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  if (now - Date.parse(lastNightly.published_at) < MINIMUM_RELEASE_GAP_MS) {
    core.info(`Nightly ${lastNightly.tag_name} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${lastNightly.tag_name}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status === "diverged") {
    // A rebasing fork leaves every old tag on a pre-rebase commit, so history cannot order them.
    const [tagCommit, candidateCommit] = await Promise.all([
      github.rest.repos.getCommit({ ...context.repo, ref: lastNightly.tag_name }),
      github.rest.repos.getCommit({ ...context.repo, ref: context.sha }),
    ]);
    if (tagCommit.data.commit.tree.sha === candidateCommit.data.commit.tree.sha) {
      core.info(
        `${lastNightly.tag_name} was cut on a rebased commit with identical content. Skipping.`,
      );
      return false;
    }
    core.warning(
      `${lastNightly.tag_name} is not an ancestor of ${context.sha} (history was rewritten), but the content differs. Releasing.`,
    );
    return true;
  }
  if (comparison.status !== "ahead") {
    core.warning(
      `Candidate commit is ${comparison.status} relative to ${lastNightly.tag_name}. Skipping the nightly release.`,
    );
    return false;
  }

  core.info(`New commits since ${lastNightly.tag_name}, and the six-hour gap has passed.`);
  return true;
}

async function resolveLatestNightlyCommit({ github, context, core }) {
  const releases = await listNightlies({ github, context });
  if (releases.length === 0) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  for (const release of releases) {
    const tag = release.tag_name;
    const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
    if (!version) {
      throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
    }
    const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
    try {
      await assertCommitOnDefaultBranch({ github, context, sha: commit.sha });
    } catch (error) {
      core.warning(`Skipping nightly ${tag}: ${error.message}`);
      continue;
    }
    core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
    return { tag, sha: commit.sha, version };
  }

  throw new Error(
    `No published nightly is contained in ${repositoryDefaultBranch(context)}. Run a nightly release first.`,
  );
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
  resolveLatestNightlyCommit,
};
