---
name: rebase-with-upstream
description: Rebase the T2 Code fork (ashutoshpw/t2code) onto upstream T3 Code (pingdotgg/t3code) and audit that the T2 Code rebrand still holds after upstream's changes are merged in. Use when rebasing main onto upstream/main, syncing the fork with upstream, or after a rebase when CI fails with "T3" strings the fork had rebranded to "T2".
---

# Rebase with upstream + rebrand audit

This fork tracks `pingdotgg/t3code` (upstream) and publishes as **T2 Code** on `ashutoshpw/t2code` (origin). A rebase replays the fork's rebrand commits on top of new upstream work, and upstream's new commits routinely contain `T3` strings the rebrand has never seen. The rebase is not done when git says it is; it is done when the brand audit passes.

## Pre-flight

1. Work from a clean tree with local `main` == `origin/main`.
2. `git fetch origin main && git fetch upstream main`.
3. Gate on CI before touching history — a rebase rewrites `main`, so starting from a red base makes the post-push loop chase failures the rebase never caused:
   ```sh
   gh run list --repo ashutoshpw/t2code --branch main --commit "$(git rev-parse origin/main)"
   ```
   - Any run still `queued` or `in_progress`: wait for it to finish before continuing.
   - Any run concluding `failure` or `cancelled`: abort. Report the failing checks and stop — do not rebase until `origin/main` is green or the user explicitly says go.
   - No runs for that SHA at all: suspicious rather than green; confirm with the user first.
4. Review divergence: `git rev-list --left-right --count origin/main...upstream/main`.
5. Dry-run the conflict surface (Git < 2.38 lacks `merge-tree --write-tree`; use the legacy form):
   ```sh
   git merge-tree "$(git merge-base upstream/main origin/main)" upstream/main origin/main
   ```
   Count real conflicts with `grep -c '^+<<<'`. Report the plan before rebasing.

## Rebase

1. `git rebase upstream/main`.
2. Conflict policy — the fork's rebrand wins for user-facing copy, but upstream's structural changes win:
   - If upstream refactored code the rebrand renamed (extracted variables, moved strings), re-apply the rebrand _inside upstream's new shape_. Example: upstream hoisted an `installArgs` array for an npm fallback path; keep the hoist, keep the `@t2code/cli` package name.
   - Env vars belong to the T2 namespace (`T2CODE_*`/`T2_*`). Upstream's new env reads and writes must be renamed inside upstream's new shape, and upstream's new tests that assert env names flip with them. External inputs keep working through the legacy-name seam (`@t2code/shared/legacyEnv`, its config helpers in `@t2code/shared/legacyEnvConfig`, and baseline-grandfathered fallback lines) — do not re-widen that seam during a rebase; new upstream variables get T2 names only.
   - Watch for upstream swapping npm packages (`t3` vs `@t2code/cli`) and URLs (keep upstream repo URLs like `github.com/pingdotgg/t3code` — those are intentional).
   - Ask the user before adopting any new GitHub Actions entry or edit to an existing one in the fork.
3. Fold conflict fixes into the fork commit they belong to (`git commit --fixup=<sha>` + `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/main`) so history stays at the fork's usual 7-ish commits.

## Rebrand audit (the part that actually catches failures)

The repo ships a brand guard: pre-commit and pre-push hooks run `scripts/check-rebrand.ts` (added staged lines, pushed ranges, and tracked paths) and fail on re-introduced T3 strings — copy, package scopes, ports, schemes, and T3-named file paths alike. Run the same audit over the whole tree before pushing:

```sh
node scripts/check-rebrand.ts --tree
node scripts/check-rebrand.ts --check-baseline
node scripts/check-rebrand.ts --audit
node scripts/check-doc-links.ts
```

`check-doc-links.ts` validates relative Markdown targets and heading anchors offline, so a renamed page (like `t3-connect.md` -> `t2-connect.md`) cannot leave stale links behind. `--audit` prints the bare `T3` tokens no rule names (legal entities, compatibility ids, fixtures, and un-rebranded copy) without failing; use its output to decide whether to add a rule or schedule a sweep.

Hits that are genuinely intentional (legacy compat, upstream references) get exempted via the allowlists in `scripts/check-rebrand.ts` or `scripts/rebrand-baseline.json` (`node scripts/check-rebrand.ts --update-baseline`) — review that diff like code, never `--no-verify`.

Upstream's new tests hardcode `T3` copy that the rebrand commits predate. These failures hide: CI jobs fail fast per package, so later suites never run and each push reveals one more. Do not trust a single green suite — sweep everything.

1. Grep and classify hits per [BRAND-AUDIT.md](./BRAND-AUDIT.md) — the full rule table, the compat-vs-must-rebrand taxonomy, and known traps from past rebases.
2. The reliable signal is execution, not eyeballing: run every test file that mentions brand copy, plus every test file touched by the rebase. A test that passes is fine regardless of why; a mismatch always shows up as `expected 'T2 …' to equal 'T3 …'` (or the reverse).

## Verify and push

1. Run targeted typecheck for the packages the rebase touched (e.g. `pnpm --filter @t2code/cli run typecheck`).
2. Update `origin/main` with `git push --force-with-lease origin main` — a rebase always rewrites the fork's main.
3. Poll CI on the pushed head. When a job fails, check whether it is a new rebrand gap (fix, fixup into the right commit, push) or a masked suite that now runs for the first time (expect a few rounds on busy rebases). Stop when every check is green on the latest commit.

## Report what changed

A finished rebase is not just a green push — close every run with a short summary the user can scan. Keep it to bullets, one line each; cite `file:line` when pointing at a specific decision.

1. **The rebase**: upstream range (old tip → new tip), how many upstream commits were picked up, how many fork commits replayed, and the pushed head SHA.
2. **Conflict work**: the resolutions that mattered, not every file — structural calls (whose side won and why), rebrands re-applied inside upstream's new shape, and any fork commit that became obsolete, was dropped, or was folded away.
3. **Rebrand gaps found**: what the audit caught and fixed, plus keeper classifications worth remembering (things that look like gaps but are intentional).
4. **Verification**: what actually ran — guard, typechecks, test suites — and their results. Note anything that could not be verified locally and is only covered by CI.
5. **Flags for the user**: pre-existing failures, deliberate deviations from upstream, removed legacy seams, and anything that needs a decision (e.g. a URL a rename would 404).

If a round was aborted, or CI is not green on the latest commit, say so explicitly instead of implying success.
