# Install T2 Code

T2 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

`npx @t2code/cli` needs Node.js only to run npm itself; the CLI it installs is a
self-contained executable. SSH hosts and WSL backends need Node.js 22.16+
(22.x), 23.11+ (23.x), or 24.10 and later. The native desktop app includes its
server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T2 Code and configure providers afterwards.

## Command line

```bash
npx @t2code/cli@latest
```

This starts the server and opens the local web app. Run
`npx @t2code/cli@latest --help` for command-line options.

To try T2 Code once without installing it, run `npx @t2code/cli@latest` instead (needs
Node.js for `npx`).

### Intel Macs

There is no `t2code` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

A server run this way is a plain Node program: `t2code update` and the background
service do not apply, so update it with `git pull` and a rebuild, and start it
however you run other Node processes.

## Desktop app

Download a release from [GitHub Releases](https://github.com/ashutoshpw/t2code/releases),
or use a package manager:

| Platform           | Install                            |
| ------------------ | ---------------------------------- |
| Windows            | `winget install T3Tools.T3Code`    |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb` |
| Arch Linux         | `yay -S t3code-bin`                |
| Arch Linux nightly | `yay -S t3code-nightly-bin`        |

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. T2 Code installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx @t2code/cli app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx @t2code/cli app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T2 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T2 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| fx          | Install [fx](https://fx.sh), then run `fx login codex`, `fx login grok`, or `fx login`.      |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from T2 Code's provider settings.                            |

Provider CLIs must be on the server's `PATH`. If T2 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T2 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T2 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [fx](./providers-fx.md),
[OpenCode](./providers-opencode.md), and [Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T2 Code](./updating.md): update the app and connected servers.
