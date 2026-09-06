export const meta = {
  name: 't2-release-followups',
  description: 'T2 Code release follow-ups (flaky tests, install docs, dirty tree, nightly schedule, smoke test, stable release) plus any extra tasks, on sonnet and haiku only',
  whenToUse: 'After the nightly release pipeline was repaired. Pass args.extraTasks to add work, args.only to pick tasks, args.approve to unlock outward actions.',
  phases: [
    { title: 'Investigate', detail: 'read-only checks in parallel', model: 'haiku/sonnet' },
    { title: 'Fix', detail: 'one writer at a time, committing to main', model: 'sonnet' },
    { title: 'Release', detail: 'gated: smoke test, then stable release', model: 'sonnet' },
    { title: 'Report', detail: 'one summary of every task', model: 'sonnet' },
  ],
}

// args: {
//   only?: string[]            task ids to run (default: all built-ins)
//   approve?: string[]         'smoke-test' | 'stable-release' (default: none)
//   extraTasks?: [{ id, title, instructions, kind: 'read'|'write', model?: 'sonnet'|'haiku' }]
//   dryRun?: boolean           log the plan, spawn nothing
// }
const cfg = args || {}
const only = Array.isArray(cfg.only) ? new Set(cfg.only) : null
const approve = new Set(Array.isArray(cfg.approve) ? cfg.approve : [])
const extra = Array.isArray(cfg.extraTasks) ? cfg.extraTasks : []
const want = (id) => !only || only.has(id)

const ALLOWED_MODELS = ['sonnet', 'haiku']
// Every agent goes through run(): the tier is always explicit and always one of
// the two allowed, so nothing inherits a bigger session model by accident.
const run = (prompt, opts = {}) => {
  const model = opts.model || 'sonnet'
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`model "${model}" is not allowed here; use sonnet or haiku`)
  }
  return agent(prompt, { ...opts, model, effort: opts.effort || (model === 'haiku' ? 'low' : 'medium') })
}

const RULES = `Context: repo ashutoshpw/t2code (fork of pingdotgg/t3code), checkout at /home/zyber/PROJECTS/ashutoshpw/t2code, branch main. Follow AGENTS.md.
Hard rules:
- Never read, list, or modify anything under ~/.t3. Do not write to ~/.t2 or start a server against it (use a throwaway T2CODE_HOME under a fresh temp dir if a task needs one).
- Never kill processes by name or pattern; only a PID you started yourself.
- The working tree has many unrelated uncommitted changes. Never stash, reset, checkout, or clean them. Never use "git add -A" or "git commit -a".
- When a task says to commit: commit only the paths you changed (git commit -- <paths>), push to main (the user wants main used directly, no branches or PRs), never force-push. If the push is rejected, git pull --rebase and retry once.
- "vp" may not be on PATH here; try ~/.vite-plus/bin/vp or "vp" from a login shell. Do not run repo-wide checks (no vp check, no vp run -r ...). Scoped tests only.
- Do not dispatch, cancel, or re-run GitHub workflows unless the task explicitly says so.
- Report only what you verified. If you could not verify something, say so.`

const STATUS = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'nothing-to-do', 'needs-user'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
}

const FLAKY = [
  {
    id: 'acp-replay-race',
    path: 'apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts',
    what: 'test "switches a mode config option under its own id" failed with "Unexpected end of JSON input" in decodeReplayStatus (AcpAdapterV2.testkit.ts) because the replay-status file was read while still empty',
  },
  {
    id: 'tunnel-zombie',
    path: 'packages/ssh/src/tunnel.test.ts',
    what: 'test "replaces a managed server that exited but was not reaped" failed with expected \'\' to include \'Z\' (ps showed no zombie on the CI runner)',
  },
  {
    id: 'mobile-diff-highlighter',
    path: 'apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.test.ts',
    what: 'test "keeps grammar state across inline comment rows" failed once with a token-list deep-equal mismatch, and passed on re-run',
  },
]

const ANALYSIS = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    realHarnessBug: { type: 'boolean' },
    rootCause: { type: 'string' },
    failuresSeenInHistory: { type: 'string' },
    proposedFix: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['id', 'realHarnessBug', 'rootCause', 'proposedFix', 'confidence'],
}

const CLAIMS = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string' },
          claim: { type: 'string' },
          kind: { type: 'string', enum: ['url', 'package-manager', 'command', 'other'] },
          target: { type: 'string' },
        },
        required: ['where', 'claim', 'kind', 'target'],
      },
    },
  },
  required: ['claims'],
}

const CHECK = {
  type: 'object',
  properties: {
    claim: { type: 'string' },
    where: { type: 'string' },
    exists: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    evidence: { type: 'string' },
  },
  required: ['claim', 'where', 'exists', 'evidence'],
}

const BUCKET = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    fileCount: { type: 'number' },
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          verdict: { type: 'string', enum: ['looks-intentional', 'rebrand-or-format-only', 'looks-accidental', 'unclear'] },
        },
        required: ['theme', 'files', 'verdict'],
      },
    },
  },
  required: ['area', 'themes'],
}

const EXTRA_BUILTIN_IDS = ['flaky-tests', 'install-docs', 'dirty-tree', 'schedule-check', 'smoke-test', 'stable-release']
for (const t of extra) {
  if (!t || !t.id || !t.instructions) throw new Error('each extraTask needs id and instructions')
  if (EXTRA_BUILTIN_IDS.includes(t.id)) throw new Error(`extraTask id "${t.id}" clashes with a built-in task`)
  if (t.model && !ALLOWED_MODELS.includes(t.model)) throw new Error(`extraTask ${t.id}: model must be sonnet or haiku`)
}
const extraRead = extra.filter((t) => t.kind !== 'write')
const extraWrite = extra.filter((t) => t.kind === 'write')

if (cfg.dryRun) {
  const plan = {
    investigate: [
      want('flaky-tests') && 'flaky-tests (sonnet x3, read-only)',
      want('install-docs') && 'install-docs audit (haiku extract + haiku check per claim)',
      want('dirty-tree') && 'dirty-tree triage (haiku per area + sonnet synthesis)',
      want('schedule-check') && 'schedule-check (haiku)',
      ...extraRead.map((t) => `extra:${t.id} (${t.model || 'sonnet'}, read)`),
    ].filter(Boolean),
    fix: [
      want('flaky-tests') && 'fix confirmed harness bugs (sonnet, one at a time, push to main)',
      want('install-docs') && 'fix docs claims that do not exist (sonnet, push to main)',
      ...extraWrite.map((t) => `extra:${t.id} (${t.model || 'sonnet'}, write)`),
    ].filter(Boolean),
    release: [
      want('smoke-test') && (approve.has('smoke-test') ? 'smoke-test (approved)' : 'smoke-test SKIPPED: not approved'),
      want('stable-release') &&
        (approve.has('stable-release') && approve.has('smoke-test')
          ? 'stable-release (approved)'
          : 'stable-release SKIPPED: needs approve smoke-test + stable-release'),
    ].filter(Boolean),
    models: ALLOWED_MODELS,
  }
  log(JSON.stringify(plan, null, 2))
  return plan
}

const results = {}

// ---------------------------------------------------------------- Investigate
phase('Investigate')

const analyses = []
const investigations = [
  want('flaky-tests') &&
    (() =>
      pipeline(FLAKY, (t) =>
        run(
          `${RULES}\n\nTask: decide whether this flaky release-gate test is a real harness bug worth fixing.\nTest file: ${t.path}\nObserved: ${t.what}\n\nRead the test and the code it exercises. Use "gh run list --workflow release.yml" and "gh api repos/ashutoshpw/t2code/actions/jobs/<id>/logs" (run logs are only available after a run completes) to see how often it failed in earlier runs. Do not change any files. Say what the root cause is, whether it is a race or environment assumption in the test itself, and the smallest fix.`,
          { label: `flaky:${t.id}`, phase: 'Investigate', schema: ANALYSIS },
        ).then((a) => {
          if (a) analyses.push(a)
          return a
        }),
      ).then((r) => {
        results['flaky-tests'] = { analyses: r.filter(Boolean) }
      })),

  want('install-docs') &&
    (async () => {
      const { claims } = await run(
        `${RULES}\n\nTask: read-only. Read README.md and docs/user/install.md and list every external install channel they promise: install-script URLs (t2.codes/install.sh, install.ps1), package-manager commands (winget, scoop, brew, apt, yay/AUR), download links, and the npm package. One claim per entry, with the file name as "where" and the URL or package name as "target".`,
        { label: 'docs:extract', phase: 'Investigate', model: 'haiku', schema: CLAIMS },
      )
      const checks = await parallel(
        claims.map((c) => () =>
          run(
            `${RULES}\n\nTask: read-only. Check whether this install claim is real right now.\nClaim: ${c.claim}\nFound in: ${c.where}\nTarget: ${c.target}\n\nFor a URL, use "curl -sSI -L --max-time 15" and report the final status and whether it is a script or an HTML error page. For a package manager entry, look it up without installing anything (for example the winget-pkgs, scoop extras, or homebrew-cask repositories with "gh api", or "npm view"). Answer yes only with evidence; answer unknown if you cannot tell.`,
            { label: `docs:check:${c.target}`.slice(0, 60), phase: 'Investigate', model: 'haiku', schema: CHECK },
          ),
        ),
      )
      results['install-docs'] = { checks: checks.filter(Boolean) }
    }),

  want('dirty-tree') &&
    (async () => {
      const AREAS = [
        { area: 'apps/server', paths: 'apps/server' },
        { area: 'apps/web', paths: 'apps/web' },
        { area: 'apps/mobile', paths: 'apps/mobile' },
        { area: 'everything else', paths: ':!apps/server :!apps/web :!apps/mobile' },
      ]
      const buckets = await parallel(
        AREAS.map((a) => () =>
          run(
            `${RULES}\n\nTask: read-only. Look at the uncommitted changes under pathspec "${a.paths}" (git status --short -- ${a.paths}; git diff --stat -- ${a.paths}; sample diffs where needed). Group the files into themes and give each theme a verdict: looks-intentional, rebrand-or-format-only, looks-accidental, or unclear. Do not modify, stage, or revert anything.`,
            { label: `tree:${a.area}`, phase: 'Investigate', model: 'haiku', schema: BUCKET },
          ),
        ),
      )
      const summary = await run(
        `${RULES}\n\nTask: read-only. Here are per-area classifications of the uncommitted changes:\n${JSON.stringify(buckets.filter(Boolean))}\n\nSpot-check the three riskiest-looking themes against the real diffs, then recommend a disposition per theme: commit to main, drop, or leave for the user to decide. Do not perform it. Be explicit about anything that could be lost work.`,
        { label: 'tree:synthesize', phase: 'Investigate', schema: STATUS },
      )
      results['dirty-tree'] = { buckets: buckets.filter(Boolean), recommendation: summary }
    }),

  want('schedule-check') &&
    (async () => {
      results['schedule-check'] = await run(
        `${RULES}\n\nTask: read-only. Check whether the scheduled "Release" workflow (cron) has published a nightly since the manual dispatch that produced npm @t2code/cli nightly 0.1.1-nightly.20261017.108. Use gh run list --workflow release.yml (event=schedule), the job conclusions, "npm view @t2code/cli dist-tags --json", and gh release list. If no scheduled run has happened since, say "too early" with the next expected cron times (38 */12 * * * UTC). If one skipped, report why from the resolve job log. Answer: resumed / too early / still skipping.`,
        { label: 'schedule-check', phase: 'Investigate', model: 'haiku', schema: STATUS },
      )
    }),

  ...extraRead.map((t) => async () => {
    results[`extra:${t.id}`] = await run(
      `${RULES}\n\nTask "${t.title || t.id}" (read-only):\n${t.instructions}`,
      { label: `extra:${t.id}`, phase: 'Investigate', model: t.model || 'sonnet', schema: STATUS },
    )
  }),
].filter(Boolean)

await parallel(investigations)

// ------------------------------------------------------------------------ Fix
// Writers commit straight to main, so they run one at a time.
phase('Fix')

if (want('flaky-tests')) {
  const fixable = analyses.filter((a) => a.realHarnessBug && a.confidence !== 'low')
  const skipped = analyses.filter((a) => !fixable.includes(a)).map((a) => `${a.id}: ${a.realHarnessBug ? 'low confidence' : 'not a harness bug'}`)
  if (skipped.length) log(`flaky-tests not fixed: ${skipped.join('; ')}`)
  results['flaky-tests'].fixes = []
  for (const a of fixable) {
    const fix = await run(
      `${RULES}\n\nTask: fix this flaky test with the smallest change that removes the race or the environment assumption. Do not add sleeps or retries; wait on the specific condition. Analysis:\n${JSON.stringify(a)}\n\nRun only the touched test file locally if you can find a working vp; otherwise say you could not. Then commit just the files you changed and push to main.`,
      { label: `fix:${a.id}`, phase: 'Fix', schema: STATUS },
    )
    results['flaky-tests'].fixes.push({ id: a.id, result: fix })
    if (fix && fix.commits && fix.commits.length) {
      const review = await run(
        `${RULES}\n\nTask: read-only independent review. Look at these commits on main: ${fix.commits.join(', ')} (git show). Check that the change fixes the stated root cause "${a.rootCause}", adds no sleeps or retries, and touches nothing unrelated. Report problems; do not edit.`,
        { label: `review:${a.id}`, phase: 'Fix', schema: STATUS },
      )
      results['flaky-tests'].fixes[results['flaky-tests'].fixes.length - 1].review = review
    }
  }
}

if (want('install-docs') && results['install-docs']) {
  const bad = results['install-docs'].checks.filter((c) => c.exists === 'no')
  const unknown = results['install-docs'].checks.filter((c) => c.exists === 'unknown')
  if (unknown.length) log(`install-docs: ${unknown.length} claim(s) could not be verified and were left alone`)
  if (bad.length) {
    results['install-docs'].fix = await run(
      `${RULES}\n\nTask: these install claims in README.md or docs/user/install.md are not real:\n${JSON.stringify(bad)}\n\nRemove or correct only those, following the docs rules in AGENTS.md (user voice, no contributor tooling, no new pages). Do not touch claims that were verified or unknown. Commit just the docs you changed and push to main.`,
      { label: 'docs:fix', phase: 'Fix', schema: STATUS },
    )
  }
}

for (const t of extraWrite) {
  const model = t.model || 'sonnet'
  // design: a read-only agent maps the code and picks the smallest design first;
  // the writer is told to follow it. review: an independent read-only pass over the commits.
  let design = ''
  if (t.design) {
    const d = await run(
      `${RULES}\n\nTask "${t.title || t.id}" - DESIGN ONLY. Do not change any files.\n${t.instructions}\n\nRead the relevant code and docs, then return a concrete plan: the smallest design that reuses what exists, the exact files to change, the contract/server/web (and mobile, MCP, docs) decisions with a reason for each, and the tests worth writing. Name anything that needs a human decision instead of guessing.`,
      { label: `design:${t.id}`, phase: 'Fix', model, schema: STATUS },
    )
    design = d ? `\n\nDesign to follow (from a read-only design pass):\n${d.summary}\n${(d.evidence || []).join('\n')}` : ''
    results[`extra:${t.id}:design`] = d
  }
  const done = await run(
    `${RULES}\n\nTask "${t.title || t.id}" (may change files; commit and push to main as described in the rules):\n${t.instructions}${design}`,
    { label: `extra:${t.id}`, phase: 'Fix', model, schema: STATUS },
  )
  results[`extra:${t.id}`] = done
  if (t.review && done && done.commits && done.commits.length) {
    results[`extra:${t.id}:review`] = await run(
      `${RULES}\n\nTask: independent read-only review of commits ${done.commits.join(', ')} on main (git show). The task was:\n${t.instructions}\n\nCheck it does what was asked, nothing unrelated changed, and the AGENTS.md "Hit every surface" list was considered. Report concrete problems with file:line; do not edit.`,
      { label: `review:${t.id}`, phase: 'Fix', model, schema: STATUS },
    )
  }
}

// -------------------------------------------------------------------- Release
phase('Release')

if (want('smoke-test')) {
  if (!approve.has('smoke-test')) {
    log('smoke-test skipped: add "smoke-test" to args.approve (it starts a server)')
    results['smoke-test'] = { status: 'needs-user', summary: 'not approved' }
  } else {
    results['smoke-test'] = await run(
      `${RULES}\n\nTask: smoke-test the published nightly on a clean setup. Create a fresh empty temp directory and a throwaway T2CODE_HOME inside it; run the package from that directory (not from the repo) with "npx @t2code/cli@nightly --version" first, then start "npx @t2code/cli@nightly serve --no-browser" (check "--help" for the real flags) bound to loopback on a free port, wait for it to answer over HTTP, fetch the root page, and stop it by the PID you captured at spawn. Confirm the launcher downloaded its executable from the GitHub Release and which version ran. Clean up the temp directory. Report exactly what you saw, including any error.`,
      { label: 'smoke-test', phase: 'Release', schema: STATUS },
    )
  }
}

if (want('stable-release')) {
  const smokeOk = results['smoke-test'] && results['smoke-test'].status === 'done'
  if (!(approve.has('stable-release') && approve.has('smoke-test') && smokeOk)) {
    log('stable-release skipped: needs args.approve to include smoke-test and stable-release, and a smoke test that passed')
    results['stable-release'] = { status: 'needs-user', summary: 'gated; not dispatched' }
  } else {
    results['stable-release'] = await run(
      `${RULES}\n\nTask: this task explicitly authorizes dispatching ONE stable release. Read docs/operations/release.md and .github/workflows/release.yml first; stable builds the commit of the latest published nightly, and needs a version (derive it from the nightly's base version). Dispatch with "gh workflow run release.yml --ref main -f channel=stable -f version=<x.y.z>", then watch the run with repeated "gh run watch" calls under 10 minutes each until it finishes. If a job fails, read its log with "gh api repos/ashutoshpw/t2code/actions/jobs/<id>/logs"; re-run only failed jobs with "gh run rerun <id> --failed" for a failure that is clearly a flaky test, and stop and report for anything else. Finish by confirming "npm view @t2code/cli dist-tags --json" shows the new latest. Do not dispatch a second release.`,
      { label: 'stable-release', phase: 'Release', schema: STATUS },
    )
  }
}

// --------------------------------------------------------------------- Report
phase('Report')

const report = await run(
  `${RULES}\n\nTask: write the final report for the user from these task results. For each task say what was done, what was verified, what was skipped and why, and what needs a human decision. Keep it short and plain. Do not invent anything that is not in the results.\n\n${JSON.stringify(results)}`,
  { label: 'report', phase: 'Report', model: 'sonnet' },
)

return { report, results }
