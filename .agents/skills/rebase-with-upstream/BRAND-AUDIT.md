# Brand audit reference

Companion to SKILL.md. What the guard covers, how to classify a hit, and the traps that have bitten past rebases. The guard is `scripts/check-rebrand.ts`; its in-file allowlists and `scripts/rebrand-baseline.json` are the only legitimate exemptions.

## What the guard rejects

Line rules run on every added line (pre-commit: staged; pre-push: pushed ranges; CI: whole tree). Path rules run once per tracked file, so a renamed or binary asset cannot carry a T3 name past a commit.

| Rule id                                                                   | Rejects                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `t2-project-file`                                                         | Restoring upstream's root `t3.json`.                                                                                                                                                                                     |
| `t2-connect-copy`                                                         | "T3 Connect" copy — "T2 Connect" is the brand. Route ids were renamed from `t3-connect` to `t2-connect` (`t2-connect-id`); compatibility identifiers such as Clerk page urls and token types are preserved separately.   |
| `t2-wordmark-ref`, `t2-mark-ref`, `t2-wordmark-label`, `t2-wordmark-path` | Retired wordmark/widget-mark components, bare `T3` aria labels, the legacy SVG path fingerprint.                                                                                                                         |
| `t2-copy`                                                                 | "T3 Code"/"T3Code" as first-party copy.                                                                                                                                                                                  |
| `t2-first-party-url`                                                      | First-party product URLs on the upstream `t3.codes` domain, bare or as a subdomain (`app.`, `relay.`, `clerk.`, `nightly.app.`). Upstream repository URLs (`github.com/pingdotgg/t3code`) are not affected.              |
| `t2-home-copy`, `t2-server-copy`                                          | The `T2 home` data directory and `T2 server` copy, in any casing.                                                                                                                                                        |
| `t2-noun-copy`, `t2-possessive-copy`                                      | Product nouns and possessives: `T3 environment`, `T3 thread`, `T3 proxy`, `T3 capture`, `T3 mark`, `T3 binary`, `T3 window`, `T3 process`, `T3's`. Identifiers that merely embed the letters are not noun copy and stay. |
| `t2-cli-scope`                                                            | `@t3code/` — an invented half-rename; the fork CLI is `@t2code/cli` (upstream ships it unscoped as `t3`).                                                                                                                |
| `t2-scope`                                                                | `@t3/` — an invented upstream-adjacent scope; fork packages are `@t2code/*`.                                                                                                                                             |
| `t3tools-scope`, `t3tools-brand`                                          | `@t3tools/` and repository-owned `t3tools` metadata; upstream repo URLs stay.                                                                                                                                            |
| `t2-context-identity`                                                     | A bare `t3/<package>/...` Effect context tag: upstream's package name made that identity correct there, while the fork qualifies every tag with `@t2code/`. Test files are skipped.                                      |
| `t2-half-rename`                                                          | References that cannot exist because a mechanical rename mixed owners or products: `pingdotgg/t2code`, `ashutoshpw/t3code`, `com.t2tools.t2code`. Test files are skipped (fixtures use synthetic owners on purpose).     |
| `t2-port`                                                                 | The upstream-only port literals `3773`, `3_773`, `13_773`; the fork's default is 3772.                                                                                                                                   |
| `t2-scheme`, `t2-scheme-preview`                                          | `t3code`/`t3code-preview` deep-link schemes outside legacy storage partition names.                                                                                                                                      |
| `t2-env-name`                                                             | `T3CODE_*`/`T3_*` env names, with no retained exceptions: the namespace is `T2CODE_*`/`T2_*`.                                                                                                                            |
| `t2-sentinel`                                                             | The setup-script completion sentinel `__T3_SETUP_DONE__`. The runner and its test must both spell `__T2_SETUP_DONE__`, or the completion wait hangs instead of failing an assertion.                                     |
| `t2-named-path`                                                           | Any tracked path containing `t3` not followed by a digit (avoids `bit31`-style false positives).                                                                                                                         |

`.agents/`, `.repos/`, and `apps/mobile/modules/` are exempt dirs; the guard's own sources are guarded files. Everything grandfathered is an exact baseline entry — `file` + line for content, `file` + empty line for paths. Remove the entry when you remove the string. `--update-baseline` regenerates the file and drops entries that no longer violate a rule; `--check-baseline` runs in CI and fails when the file and the tree disagree, so a stale exemption cannot sit unnoticed.

## Classifying a sweep hit

Grep for brand strings across tests and copy-bearing files:

```sh
rg -n "T3 Code|T3_CODE|@t3code/cli|@t3tools/|t3tools|@t2code/" -g '!node_modules' -g '!.t3' -g '!.repos' -g '!patches/**'
rg -no "(?<![A-Za-z0-9_])T3(?:CODE)?_[A-Z0-9_]+" -g '!node_modules' -g '!.t3' -g '!.repos' -g '!.agents' -g '!patches/**'
```

- **Intentional, leave alone:** upstream repo URLs, compatibility-bound platform identifiers (bundle ids like `com.t3tools.t3code`, the AUR `t3code-bin` package name), vendored `.repos/`, git blob SHAs inside `patches/`, historical validation notes in comments, mock strings echoed verbatim by both source and test, and the stored-data spellings listed under "The audit's expected remainder".
- **Must be T2:** user-facing copy, error messages, announcements, embedded playbook/prompt text, release names, showcase data — anywhere the source was rebranded but a test fixture or doc still says T3.

## Known traps from past rebases

- **Stored data spells the name too.** A rename must not touch a string that already exists on disk, because the migration that carries an existing install forward has to look for the spelling the old build wrote. Legacy theme ids, the desktop V1 profile names and storage keys, the legacy CLI home, and the `refs/t3/orchestration-v2/checkpoints` namespace are all load-bearing. Rename the _current_ spelling and rewrite the old one; renaming the old spelling in place silently strands the data (see `063_LegacyMcpIdentityRewrite`).
- **Numeric literals with separators**: `3_773` and `13_773` do not match a `3773` grep. Search derived literals separately.
- **Derived expectations**: tests that compute ports from a base constant shift by one when the base moves; exhaustion-boundary tests (e.g. `startOffset` where `base + offset > 65535`) must be recomputed, not string-replaced.
- **Embedded copies that must stay byte-identical**: `apps/server/src/cli/triagePrompt.ts` (`TRIAGE_PLAYBOOK`) and `.github/triage/PLAYBOOK.md` must match exactly — rebrand both or neither.
- **Fixtures as inputs vs expectations**: a `releaseName` a test feeds in and asserts back verbatim can stay as-is only if it is not rebranded upstream; if the real producer (e.g. `resolve-nightly-release.ts`) emits T2, rebrand the fixture too so the test stays realistic.
- **Recorded transcripts are inputs**: the `testkit/fixtures/*_transcript.ndjson` files replay provider traffic. When upstream's own frames drift structurally (a dropped `get_commands`, a new skill connection), regenerate the fixture from `upstream/main` and map the rename forward instead of editing the fork's copy; a stale fixture otherwise waits for frames that never arrive and burns the scenario timeout.
- **A conflict resolution can keep a stale side**: when a fixture or data file is in doubt, diff it against `upstream/main` with the rename mapping rather than trusting `HEAD`.

## The audit's expected remainder

`--audit` prints bare `T3` tokens no rule names, and the baseline lists what the rules do flag on purpose. These are the expected hits; anything else is a gap worth a rule or a rename:

- Migration `063_LegacyMcpIdentityRewrite` and its test name the pre-rename MCP server and tool spellings, because stored transcripts carry them.
- Stored-data spellings the guard never flags: the `LEGACY_THEME_ID_ALIASES` keys and `LEGACY_T3_CHAT_DARK_THEME_ID` in `apps/web/src/themePalette.ts`, `V1_PROFILE_NAMES` in `apps/desktop/src/app/DesktopLegacyLocalStorage.ts`, the previous app-data directories in `apps/desktop/src/app/DesktopUserData.ts`, the imported key namespaces in `apps/desktop/src/legacyLocalStorageMerge.ts`, and the `refs/t3/orchestration-v2/checkpoints` namespace.
- The marketing App Store link in `apps/marketing/src/lib/site.ts` and `README.md` still carries upstream's listing slug until the fork publishes its own.
- The baseline's two fixture entries: a `T3 home` test name in `apps/desktop/src/app/DesktopCliCommand.test.ts`, and a UUID in a recorded Claude transcript whose digits happen to contain `3773`.
- `apps/mobile/deps/react-native-*-t3.13.tgz` / `-t3.27.tgz` are third-party artifact names that ship as-is.
- The `T3 Chat` palette (comments, tests, and the palette label) references the t3.chat product, not this fork.
- `t2_relay` stays in `RelayManagedEndpointProviderKind`: it is a persisted relay value that the server deliberately rejects, not a current provider.
