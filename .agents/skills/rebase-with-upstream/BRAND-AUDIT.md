# Brand audit reference

Companion to SKILL.md. What the guard covers, how to classify a hit, and the traps that have bitten past rebases. The guard is `scripts/check-rebrand.ts`; its in-file allowlists and `scripts/rebrand-baseline.json` are the only legitimate exemptions.

## What the guard rejects

Line rules run on every added line (pre-commit: staged; pre-push: pushed ranges; CI: whole tree). Path rules run once per tracked file, so a renamed or binary asset cannot carry a T3 name past a commit.

| Rule id                                                                   | Rejects                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3-connect-copy`                                                         | "T3 Connect" copy anywhere — "T2 Connect" is the brand. Compatibility identifiers (module names like `T3ConnectUserProfilePage`, route ids like `t3-connect`, token types like `t3-link-challenge+jwt`) are not copy; they stay. |
| `t3-copy`                                                                 | "T3 Code"/"T3Code" as first-party copy.                                                                                                                                                                                          |
| `t3-wordmark-ref`, `t3-mark-ref`, `t3-wordmark-label`, `t3-wordmark-path` | Retired wordmark/widget-mark components, bare `T3` aria labels, the legacy SVG path fingerprint.                                                                                                                                 |
| `t3-cli-scope`                                                            | `@t3code/` — an invented half-rename; the fork CLI is `@t2code/cli` (upstream ships it unscoped as `t3`).                                                                                                                        |
| `t3-scope`                                                                | `@t3/` — an invented upstream-adjacent scope; fork packages are `@t2code/*`.                                                                                                                                                     |
| `t3tools-scope`, `t3tools-brand`                                          | `@t3tools/` and repository-owned `t3tools` metadata; upstream repo URLs stay.                                                                                                                                                    |
| `t3-port`                                                                 | 3773 and derived `3_773`/`13_773` literals; the fork's port is 3772.                                                                                                                                                             |
| `t3-scheme`, `t3-scheme-preview`                                          | `t3code`/`t3code-preview` deep-link schemes outside legacy storage partition names.                                                                                                                                              |
| `t3-named-path`                                                           | Any tracked path containing `t3` not followed by a digit (avoids `bit31`-style false positives).                                                                                                                                 |
| `t3-project-file`                                                         | Restoring upstream's root `t3.json`.                                                                                                                                                                                             |

`.agents/`, `.repos/`, and `apps/mobile/modules/` are exempt dirs; the guard's own sources are guarded files. Everything grandfathered is an exact baseline entry — `file` + line for content, `file` + empty line for paths. Remove the entry when you remove the string.

## Classifying a sweep hit

Grep for brand strings across tests and copy-bearing files:

```sh
rg -n "T3 Code|T3_CODE|@t3code/cli|@t3tools/|t3tools|@t2code/" -g '!node_modules' -g '!.t3' -g '!.repos' -g '!patches/**'
```

- **Intentional, leave alone:** upstream repo URLs, compatibility-bound platform identifiers (bundle ids like `com.t3tools.t3code`, the AUR `t3code-bin` package name), upstream `@t2code/*` package scope (upstream's CLI is unscoped `t3`; the fork's packages are `@t2code/*` — any `@t2code/` or `@t3code/` outside exempt dirs is a rebase gap), vendored `.repos/`, git blob SHAs inside `patches/`, historical validation notes in comments, mock strings echoed verbatim by both source and test. Existing `t3tools` exceptions must be exact baseline entries; do not add a blanket directory exemption for new hits.
- **Must be T2:** user-facing copy, error messages, announcements, embedded playbook/prompt text, release names, showcase data — anywhere the source was rebranded but a test fixture or doc still says T3.

## Known traps from past rebases

- **Numeric literals with separators**: `3_773` and `13_773` do not match a `3773` grep. Search `\d_773`, `13_773`, `14_607`-style derived literals separately.
- **Derived expectations**: tests that compute ports from a base constant shift by one when the base moves; exhaustion-boundary tests (e.g. `startOffset` where `base + offset > 65535`) must be recomputed, not string-replaced.
- **Embedded copies that must stay byte-identical**: `apps/server/src/cli/triagePrompt.ts` (`TRIAGE_PLAYBOOK`) and `.github/triage/PLAYBOOK.md` must match exactly — rebrand both or neither.
- **Fixtures as inputs vs expectations**: a `releaseName` a test feeds in and asserts back verbatim can stay as-is only if it is not rebranded upstream; if the real producer (e.g. `resolve-nightly-release.ts`) emits T2, rebrand the fixture too so the test stays realistic.
