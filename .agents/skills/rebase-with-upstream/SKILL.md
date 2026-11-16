---
name: rebase-with-upstream
description: Rebase the T2 Code fork (ashutoshpw/t2code) onto upstream T3 Code (pingdotgg/t3code) and audit that the T2 Code rebrand still holds after upstream's changes are merged in. Use when rebasing main onto upstream/main, syncing the fork with upstream, or after a rebase when CI fails with "T3" strings the fork had rebranded to "T2".
---

# Rebase with upstream + rebrand audit

This fork tracks `pingdotgg/t3code` (upstream) and publishes as **T2 Code** on `ashutoshpw/t2code` (origin). A rebase replays the fork's rebrand commits on top of new upstream work, and upstream's new commits routinely contain `T3` strings the rebrand has never seen. The rebase is not done when git says it is; it is done when the brand audit passes.

## Pre-flight

1. Work from a clean tree with local `main` == `origin/main`. `git fetch origin main && git fetch upstream main`.
2. Gate on CI before touching history; a red base makes the post-push loop chase failures the rebase never caused. Check both workflows:
   ```sh
   gh run list --repo ashutoshpw/t2code --branch main --commit "$(git rev-parse origin/main)"
   gh run list --repo ashutoshpw/t2code --workflow Release --limit 5
   ```
   - `queued` or `in_progress`: wait. Queued for hours is a stranded `blacksmith-*` label, not a reason to wait (see Rebase).
   - `failure` or `cancelled` on `CI`: abort and report. The `Release` workflow is not path-gated and runs nightly, so a red scheduled `Release` run is a pre-existing break to record in the report, not something to inherit silently.
   - No runs for that SHA: suspicious rather than green; confirm with the user.
3. Divergence: `git rev-list --left-right --count origin/main...upstream/main`.
4. Save a recovery branch and record the snapshot. The snapshot file stays outside the worktree and is never committed or edited:
   ```sh
   git branch pre-rebase-$(date +%Y%m%d) origin/main
   node scripts/check-rebase-safety.ts snapshot --head pre-rebase-$(date +%Y%m%d) --file /tmp/t2-rebase-snapshot.json
   ```
   `--head` is the fork ref to read (default `HEAD`); `--upstream` defaults to `upstream/main`. The snapshot records, from commits only, what the fork carries over upstream: added and deleted files, per-file fork delta, commit subjects and sizes, CLI/RPC/migration registrations, workflow structure (jobs, `needs`, `if`, `runs-on`, matrix keys, step names), the lines the fork added to `pnpm-workspace.yaml` and `migrate-dev-db.test.ts`, the agent context budget, T3 token counts per file (strict, and bare lowercase `t3` / `T3Code`), and app-store links.
   Auditing a finished rebase: `snapshot --head <pre-rebase ref> --upstream <sha rebased onto>`, then `verify --head <result> --upstream <same sha>`. `upstream/main` may have moved on; the wrong tip reports unrelated drift.
5. Dry-run the conflict surface and report the plan before rebasing (Git < 2.38 lacks `merge-tree --write-tree`):
   ```sh
   git merge-tree "$(git merge-base upstream/main origin/main)" upstream/main origin/main | grep -c '^+<<<'
   ```

## Rebase

1. `git rebase upstream/main`.
2. Conflict policy. Fork intent wins for fork-owned files; upstream wins on structure. When both touched the same lines, re-apply the fork's change inside upstream's new shape; never take a whole file from either side, and never resolve toward the fork's older text just because it is what was there.
   - **Fork-owned, keep:** the T2 rebrand (copy, package scopes, env namespace `T2CODE_*`, URLs; upstream repo URLs stay), GitHub-hosted runners, the web-test `strategy.matrix.shard`, `pnpm-workspace.yaml` overrides the fork added (`unenv` pin), the fork migration ledger (`forkMigrations.ts`, `ForkMigrations/`), the Spaces migration chain, `agentContextBudget.json` (take the larger value), and the lists in `migrate-dev-db.test.ts`.
   - **Upstream-owned, take:** new upstream jobs, steps, conditions, lint rules (`oxlint-plugin-*/rules/*` and their enabling in `vite.config.ts`), migrations (ids and names verbatim, never renumbered), tests and test cases, and docs. Then rebrand them.
   - Legacy `T3CODE_*` names and the `~/.t3` home live only in `packages/shared/src/legacyT3Identity.ts`; new upstream variables get T2 names only.
   - Runners: map `blacksmith-{2,4,8}vcpu-ubuntu-*` to `ubuntu-24.04` and `blacksmith-*vcpu-macos-*` to `macos-26`. Ask before adopting any other new Actions entry.
   - When upstream rewrote text the fork only rebranded (a tool description, a schema description, a comment), take upstream's new text and rebrand it. Keeping the fork's side reverts upstream's change silently, and the code beside it no longer matches the text.
   - When upstream adds UI or behavior equal to a fork feature, keep one. Search for the new upstream surface before restoring the fork's wiring, so the state is not rendered twice.
   - Line-wrapped prose hides brand strings from single-line rules; read the whole sentence.
   - A fork commit that becomes obsolete is dropped on purpose and written in the report with its subject; nothing else is dropped.
3. Fold every fix into the fork commit it repairs (`git commit --fixup=<sha>`, `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/main`). No "repair rebase damage" commits on top.

## Verify (before pushing)

Run in order; fix each failure in the commit that caused it and rerun from the top. Pass the rebased result with `--head` if it is not checked out.

1. **Lost work.** `node scripts/check-rebase-safety.ts verify --file /tmp/t2-rebase-snapshot.json`. Fails on: a fork-added file gone; a fork commit that is empty or shrank sharply; a file that lost its fork delta; an unregistered CLI command, RPC, or migration (fork, Spaces, main chain vs upstream); workflow structure the fork had (jobs, matrix, `needs`, `if`, `runs-on`, steps) that is missing, including an `if`/`needs`/matrix/step upstream added to a job the result keeps (merge upstream's change; do not accept it as a fork decision), or `blacksmith-*` labels back; fork-added lines gone from `pnpm-workspace.yaml`, `migrate-dev-db.test.ts`, or the migration manifests; `agentContextBudget.json` lowered; T3 spellings, bare `t3` in source files (a comment or path saying `t3 up` where the CLI is `t2`), or new app-store links that were not in the fork; lines upstream deleted or rewrote that are back in the result (a conflict resolved to the fork's older text; fork-owned code that must keep a line is `--accept`ed with the reason); an upstream test case, test file, or lint rule file missing. Notes starting `REVIEW` (including bare `t3` growth in test files, whose stale literals fail only when the suite runs) list upstream-added workflow/pnpm lines the result lacks and files the fork still deletes: each one is either intentional or a conflict resolved toward the fork's older behavior; decide, and name it in the report. Restore each loss from the commit that lost it. A loss the report names as intentional is passed with `--accept "<text>"` (substring of the failing item); it then prints as `ACCEPTED` for the report. Never edit the snapshot or accept to make the guard pass.
2. **Brand.** `node scripts/check-rebrand.ts --full`, `--audit`, and `node scripts/check-doc-links.ts` (see Rebrand audit).
3. **Migrations and budget.** `vp test run apps/server/scripts/migrate-dev-db.test.ts apps/server/src/provider/AgentContextBudget.test.ts`, plus `node scripts/check-release-versions.ts`.
4. **Release.** `node scripts/release-smoke.ts`. CI runs it too, and the `Release` workflow is the one that broke every nightly once.
5. **CLI and docs.** `node apps/server/src/bin.ts --help` lists every subcommand registered in `apps/server/src/binCli.ts`, and `docs/user/install.md` describes the same set.
6. **Changed files.** `vp run check:changed`. `*.browser.test.tsx` need `LD_LIBRARY_PATH=/home/zyber/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu` locally, one file per run; CI's `Test Web` job is their authoritative verifier.

## Never

- Renumber or rename an upstream migration, or give a fork migration an id in the main chain.
- Add a baseline entry or allowlist line to make a guard pass; fix the code. Only intentional hits (legacy compat, upstream references) are exempt, with a reason.
- Restore files blanket-wise (`git checkout <ref> -- dir/`); restore the lost hunks.
- Append repair commits when the damage can be folded into the commit that caused it.
- Edit the snapshot, or push with `--no-verify`.

## Rebrand audit (the part that actually catches failures)

The repo ships a brand guard: pre-commit and pre-push hooks run `scripts/check-rebrand.ts` (added staged lines, pushed ranges, and tracked paths) and fail on re-introduced T3 strings — copy, package scopes, ports, schemes, and T3-named file paths alike. `--full` is the CI mode (every tracked file plus the baseline check). Run it over the whole tree before pushing:

```sh
node scripts/check-rebrand.ts --full
node scripts/check-rebrand.ts --audit
node scripts/check-doc-links.ts
```

`check-doc-links.ts` validates relative Markdown targets and heading anchors offline, so a renamed page (like `t3-connect.md` -> `t2-connect.md`) cannot leave stale links behind. `--audit` prints the bare `T3` tokens no rule names (legal entities, compatibility ids, fixtures, and un-rebranded copy) without failing; use its output to decide whether to add a rule or schedule a sweep.

Hits that are genuinely intentional (legacy compat, upstream references) get exempted via the allowlists in `scripts/check-rebrand.ts` or `scripts/rebrand-baseline.json` (`node scripts/check-rebrand.ts --update-baseline`) — review that diff like code, never `--no-verify`.

Upstream's new tests hardcode `T3` copy that the rebrand commits predate. These failures hide: CI jobs fail fast per package, so later suites never run and each push reveals one more. Do not trust a single green suite — sweep everything.

1. Grep and classify hits per [BRAND-AUDIT.md](./BRAND-AUDIT.md) — the full rule table, the compat-vs-must-rebrand taxonomy, and known traps from past rebases.
2. The reliable signal is execution, not eyeballing: run every test file that mentions brand copy, plus every test file touched by the rebase. A test that passes is fine regardless of why; a mismatch always shows up as `expected 'T2 …' to equal 'T3 …'` (or the reverse).

## Push and CI loop

1. `git push --force-with-lease origin main`.
2. A round is not finished until every run for the pushed head has concluded `success` or `skipped`. Gating runs are `CI`, `Rebrand check`, and **`Release`** (it runs on the nightly schedule, so a workflow broken by the rebase fails silently until the next nightly; watch any run the push starts, and never `workflow_dispatch` it to test, because that can publish):
   ```sh
   gh run list --repo ashutoshpw/t2code --branch main --commit "$(git rev-parse HEAD)"
   gh run watch <run-id> --repo ashutoshpw/t2code --exit-status
   ```
   Deploy and publish runs (relay, mobile, labels) report separately; chase them only when the rebase plausibly caused the failure, and flag credential or infra failures instead of papering over them.
3. `queued` for hours: a `blacksmith-*` label survived. Grep `.github/workflows/`, map it, cancel the stranded runs, fix it.
4. Classify each failure (`gh run view <id> --repo ashutoshpw/t2code --log-failed`): a rebrand gap (fix the string; add a rule in `scripts/check-rebrand.ts` when the class can recur), a structural resolution bug (reproduce with `vp test run <file>`), a loss the guard missed (extend `scripts/check-rebase-safety.ts` with a table case in its test, so the class is caught next time), a masked suite running for the first time, or an environment-only failure. Never add `it.skip`.
5. Fold the fix into the fork commit it repairs, rerun Verify from the top, push. Hooks stay on.
6. When green, check the nightly gate: the scheduled `Release` run must publish or explain itself with a warning annotation from `.github/scripts/check-nightly-release.cjs`. A silent skip means the gate is wrong (for example the last nightly tag is not an ancestor of `main`).

## Report what changed

A finished rebase is not just a green push — close every run with a short summary the user can scan. Keep it to bullets, one line each; cite `file:line` when pointing at a specific decision.

1. **The rebase**: upstream range (old tip → new tip), how many upstream commits were picked up, how many fork commits replayed, and the pushed head SHA.
2. **Conflict work**: the resolutions that mattered, not every file — structural calls (whose side won and why), rebrands re-applied inside upstream's new shape, and any fork commit that became obsolete, was dropped, or was folded away.
3. **Rebrand gaps found**: what the audit caught and fixed, plus keeper classifications worth remembering (things that look like gaps but are intentional).
4. **Accepted losses**: every `--accept`ed item, every obsolete or dropped fork commit, and every `REVIEW` note with its decision (kept for upstream, kept for the fork, and why). Empty is written as "none".
5. **Verification**: each Verify step with its result (`check-rebase-safety`, brand guard, migrations and budget tests, release-smoke, `check:changed`), and run links for `CI`, `Rebrand check`, and `Release` on the final head.
6. **Flags for the user**: pre-existing failures, deliberate deviations from upstream, removed legacy seams, and anything that needs a decision (e.g. a URL a rename would 404).

If a round was aborted, or CI is not green on the latest commit, say so explicitly instead of implying success.
