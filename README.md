# soksak-plugin-acp-core

A library plugin for managing AI coding agents in soksak. No UI.

Runs AI agents such as Claude, Codex, and Gemini as subprocesses and communicates with
them via ACP (Agent Client Protocol, the standard communication protocol between editors
and AI coding agents). Exposes this functionality through commands and events.

## Commands

| Command | Description |
|--------|------|
| `connect` | Launch and connect to an agent (preset: claude·codex·gemini, or a custom run command) |
| `session-new` | Start a new conversation session |
| `prompt` | Send a prompt and collect the response |
| `cancel` / `disconnect` / `connections` | Cancel a turn / close a connection / list connections |

Response chunks also flow out as `acp.update.<connection-id>` events, which can be
subscribed to for real-time rendering.

## Agent CLIs

Each agent requires its own CLI. These CLIs are declared as `libraries` in the manifest
and are force-installed if missing when the plugin is enabled (the consent screen shows
the install command verbatim). The installed global binary is executed by absolute path,
so PATH binding is not required.

| Agent | CLI | Notes |
|----------|-----|------|
| claude | `@agentclientprotocol/claude-agent-acp` | Official CLI does not support ACP, so an adapter is used |
| codex | `@agentclientprotocol/codex-acp` | Bridges the codex CLI (ChatGPT) to ACP |
| gemini | `@google/gemini-cli` | Google's official CLI supports ACP natively (`--acp`) |

Authentication for each agent is handled on the CLI side (claude=Claude account,
codex=ChatGPT, gemini=Google).

## Build

```
npm install
npm run build   # esbuild → main.js (includes ACP SDK)
npm test
```

Installation only requires cloning (the built `main.js` is tracked; no separate build
step needed).

## Dependencies

- soksak `process` capability — subprocess execution + bidirectional stdio.
- `@agentclientprotocol/sdk` — ACP TypeScript SDK. Agent adapters use the latest
  `@agentclientprotocol/*` versions.
