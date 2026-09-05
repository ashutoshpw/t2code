---
name: rebase-with-upstream
description: Rebase the T2 Code fork (ashutoshpw/t2code) onto upstream T3 Code (pingdotgg/t3code) and audit that the T2 Code rebrand still holds after upstream's changes are merged in. Use when rebasing main onto upstream/main, syncing the fork with upstream, or after a rebase when CI fails with "T3" strings the fork had rebranded to "T2".
---

# Rebase with upstream + rebrand audit

This fork tracks `pingdotgg/t3code` (upstream) and publishes as **T2 Code** on `ashutoshpw/t2code` (origin). A rebase replays the fork's rebrand commits on top of new upstream work, and upstream's new commits routinely contain `T3` strings the rebrand has never seen. The rebase is not done when git says it is; it is done when the brand audit passes.

## Pre-flight

1. Work from a clean tree with local `main` == `origin/main`.
2. `git fetch origin main && git fetch upstream main`.
3. Review divergence: `git rev-list --left-right --count origin/main...upstream/main`.
4. Dry-run the conflict surface (Git < 2.38 lacks `merge-tree --write-tree`; use the legacy form):
   ```sh
   git merge-tree "$(git merge-base upstream/main origin/main)" upstream/main origin/main
   ```
   Count real conflicts with `grep -c '^+<<<'`. Report the plan before rebasing.

## Rebase

1. `git rebase upstream/main`.
2. Conflict policy — the fork's rebrand wins for user-facing copy, but upstream's structural changes win:
   - If upstream refactored code the rebrand renamed (extracted variables, moved strings), re-apply the rebrand _inside upstream's new shape_. Example: upstream hoisted an `installArgs` array for an npm fallback path; keep the hoist, keep the `@t2code/cli` package name.
   - Watch for upstream swapping npm packages (`t3` vs `@t2code/cli`) and URLs (keep upstream repo URLs like `github.com/pingdotgg/t3code` — those are intentional).
3. Fold conflict fixes into the fork commit they belong to (`git commit --fixup=<sha>` + `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/main`) so history stays at the fork's usual 7-ish commits.

## Rebrand audit (the part that actually catches failures)

Upstream's new tests hardcode `T3` copy that the rebrand commits predate. These failures hide: CI jobs fail fast per package, so later suites never run and each push reveals one more. Do not trust a single green suite — sweep everything.

1. Grep for brand strings across tests and copy-bearing files:
   ```sh
   rg -n "T3 Code|T3_CODE|@t3code/cli" -g '!node_modules' -g '!.t3' -g '!.repos' -g '!patches/**'
   ```
2. Classify each hit:
   - **Intentional, leave alone:** upstream repo URLs, internal `@t3code/*` package scope, vendored `.repos/`, git blob SHAs inside `patches/`, historical validation notes in comments, mock strings echoed verbatim by both source and test.
   - **Must be T2:** user-facing copy, error messages, announcements, embedded playbook/prompt text, release names, showcase data — anywhere the source was rebranded but a test fixture or doc still says T3.
3. The reliable signal is execution, not eyeballing: run every test file that mentions brand copy, plus every test file touched by the rebase. A test that passes is fine regardless of why; a mismatch always shows up as `expected 'T2 …' to equal 'T3 …'` (or the reverse).
4. Known traps from past rebases:
   - **Numeric literals with separators**: `3_773` and `13_773` do not match a `3773` grep. Search `\d_773`, `13_773`, `14_607`-style derived literals separately.
   - **Derived expectations**: tests that compute ports from a base constant shift by one when the base moves; exhaustion-boundary tests (e.g. `startOffset` where `base + offset > 65535`) must be recomputed, not string-replaced.
   - **Embedded copies that must stay byte-identical**: `apps/server/src/cli/triagePrompt.ts` (`TRIAGE_PLAYBOOK`) and `.github/triage/PLAYBOOK.md` must match exactly — rebrand both or neither.
   - **Fixtures as inputs vs expectations**: a `releaseName` a test feeds in and asserts back verbatim can stay as-is only if it is not rebranded upstream; if the real producer (e.g. `resolve-nightly-release.ts`) emits T2, rebrand the fixture too so the test stays realistic.

## Verify and push

1. Run targeted typecheck for the packages the rebase touched (e.g. `pnpm --filter @t2code/cli run typecheck`).
2. Update `origin/main` with `git push --force-with-lease origin main` — a rebase always rewrites the fork's main.
3. Poll CI on the pushed head. When a job fails, check whether it is a new rebrand gap (fix, fixup into the right commit, push) or a masked suite that now runs for the first time (expect a few rounds on busy rebases). Stop when every check is green on the latest commit.
