# fx

fx is an experimental coding agent that can use Vercel AI Gateway, an eligible ChatGPT subscription through Codex OAuth, or an eligible Grok subscription through xAI OAuth.

## Install

Install fx on the machine running the T2 Code server:

```bash
curl -fsSL https://fx.sh/setup.sh | bash
```

If T2 Code cannot find `fx` on `PATH`, open **Settings**, select the fx provider, and set its **Binary path**.

## Authenticate

Choose the account you want fx to use before starting a T2 Code thread.

For Codex subscription access:

```bash
fx login codex
```

For Grok subscription access:

```bash
fx login grok
```

For Vercel AI Gateway:

```bash
fx login
```

fx stores and refreshes these sessions itself. T2 Code launches `fx acp` and uses the provider and model catalog selected by fx.

## Enable In T2 Code

fx is off by default while the integration is in early access.

1. Open **Settings**.
2. Enable the fx provider.
3. Refresh its status.
4. Pick an fx model when creating a thread.

Use fx's `/setup` command in a terminal to switch between Gateway, Codex, and Grok. Refresh the provider in T2 Code afterwards to load the active catalog.

## Troubleshooting

- Run `fx --version` on the T2 Code server to confirm the binary is available.
- Run `fx` in the project once to verify the selected subscription works.
- If models are missing, finish `fx login codex`, `fx login grok`, or `fx login`, then refresh the provider status.
- Model changes use fx's standard ACP model configuration and work in existing T2 Code threads.
