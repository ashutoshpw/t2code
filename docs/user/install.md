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

To install the standalone CLI without Node.js or npm, run:

```bash
curl -fsSL https://t2.codes/install.sh | sh
```

On Windows, use PowerShell:

```powershell
irm https://t2.codes/install.ps1 | iex
```

This installs the `t2` binary to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `t2` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If a `t2` that the
installer or the desktop app did not create is already there, it leaves that
one alone and stops. Set `T2CODE_CHANNEL=nightly` to install the nightly train, or
`T2CODE_VERSION` to pin an exact version.

| Task                                  | Command                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Start the server and open the web app | `t2`                                                                    |
| Start the server without a browser    | `t2 serve`                                                              |
| Use it from your other devices        | `t2 up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `t2 service install` ([details](./background-service.md))               |
| Move to the newest release            | `t2 update`                                                             |
| Reclaim database space                | `t2 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `t2 uninstall`                                                          |

This starts the server and opens the local web app. Run
`npx @t2code/cli@latest --help` for command-line options.

### Run one prompt from the terminal

Use `exec` with a harness selector to send one prompt and print its final answer
without opening the harness's interactive interface:

```bash
npx @t2code/cli --provider claude exec "Summarize this project"
```

`--provider` also accepts `-p`. Supported values are `claude`, `codex`,
`opencode`, `cursor`, and `grok`. For example:

```bash
npx @t2code/cli -p codex exec "Explain the failing test"
npx @t2code/cli --provider cursor exec "Review this project"
```

The selected CLI must be installed, authenticated, and on the current shell's
`PATH`. This command runs it in the current directory and uses that CLI's own
configuration and permissions; it does not use provider instance settings saved
in T2 Code. Antigravity is not available here because T2 Code connects to its
ACP runtime directly instead of invoking a prompt-oriented CLI. If the CLI
exits with an error, `exec` reports it and exits non-zero.

To try T2 Code once without installing it, run `npx @t2code/cli@latest` instead (needs
Node.js for `npx`). It offers to install the `t2` command first. If you say no,
it asks again at the next minor release, and `npx @t2code/cli install` installs
it later. `npx @t2code/cli` always runs the version npm picked, even when a `t2`
is installed. On the nightly train, run your installed `t2` (for example
`t2 connect`), not `npx @t2code/cli`, which runs the latest stable release.

### Intel Macs

There is no `t2` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](https://github.com/ashutoshpw/t2code#install-vp)):

```bash
git clone https://github.com/ashutoshpw/t2code
cd t2code && vp i && vp run build:desktop
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
| Debian, Ubuntu     | `sudo apt install ./T2-Code-*.deb` |
| Arch Linux         | `yay -S t2code-bin`                |
| Arch Linux nightly | `yay -S t2code-nightly-bin`        |

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Code.AppImage
./T3-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

The AUR packages currently support x86_64 only; on ARM64, use the AppImage.
Update AUR installs with your AUR helper, such as `yay -Syu`, instead of the
in-app updater.

### The `t2code` command

The desktop app includes the `t2code` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**t2 command** in **Settings → About**. On macOS and Linux it adds a `t2code`
link in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder
to your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `t2code`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T2 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

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

Install T2 Code from
[Google Play](https://play.google.com/store/apps/details?id=codes.t2.mobile).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T2 Connect or a pairing URL.

Store links and QR codes are also available in **Settings → About → Mobile app**
on web and desktop. The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta releases](https://github.com/ashutoshpw/t2code/releases?q=android-beta-).

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

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T2 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T2 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T2 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when T2 Code cannot tell. Claude, Codex, and
OpenCode installs T2 Code cannot identify stay manual: update them through the
installer you used. T2 Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with T2 Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T2 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating T2 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T2 Code for everyone on a machine.
