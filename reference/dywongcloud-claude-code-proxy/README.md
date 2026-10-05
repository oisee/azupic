# claude-code-proxy — OpenAI + Moonshot API-key edition

A complete, dependency-free local proxy that lets **Claude Code** use:

- an **OpenAI Platform API key** through the public **Responses API**; and
- a **Moonshot API key** through the OpenAI-compatible **Chat Completions API**, including **Kimi K3**.

It exposes the Anthropic endpoints Claude Code expects and translates requests, streams, reasoning, tool calls, tool results, images, usage, and errors in both directions.

This is an API-key-focused edition of the public interface pioneered by [`raine/claude-code-proxy`](https://github.com/raine/claude-code-proxy). It intentionally removes the need for ChatGPT/Kimi OAuth subscription login. See [UPSTREAM.md](UPSTREAM.md) and [MIGRATION.md](MIGRATION.md).

## What is included

- `POST /v1/messages` — streaming and non-streaming Anthropic Messages
- `POST /v1/messages?beta=true` — Claude Code-compatible alias
- `POST /v1/messages/count_tokens` — conservative local estimate
- `GET /healthz`, `GET /models`, `GET /v1/models`
- OpenAI Responses translation with reasoning summaries, encrypted stateless reasoning replay, text, function calls, prompt cache keys, usage, and service tiers
- Moonshot/Kimi K3 Chat Completions translation with `reasoning_content`, tools, images, K3 effort values, and final usage chunks
- Claude Code 2.1.154+ inline `system`/`developer` message normalization for both providers
- masked interactive API-key login
- macOS Keychain storage by default; mode-`0600` credential files elsewhere
- environment-only authentication for servers and containers
- retries before stream commitment, `Retry-After` handling, stream idle timeouts, heartbeats, request/response size limits, log redaction, and inbound proxy authentication for non-loopback binds
- Docker, Docker Compose, installer, CI, and an offline test suite
- no npm runtime dependencies

## Requirements

- Node.js **20.12 or newer**
- Claude Code
- an OpenAI Platform key, a Moonshot key, or both

## Quick start

### 1. Install from this source tree

macOS/Linux:

```bash
./scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

Windows PowerShell:

```powershell
.\scripts\install.ps1
```

The installer copies the project to `~/.local/lib/claude-code-proxy` and installs the `claude-code-proxy` command in `~/.local/bin`.

Running directly is also supported:

```bash
node ./bin/claude-code-proxy.js --version
```

### 2. Configure API keys

Environment variables are the simplest option:

```bash
export OPENAI_API_KEY='sk-...'
export MOONSHOT_API_KEY='...'
```

The CCP-prefixed names take precedence:

```bash
export CCP_OPENAI_API_KEY='sk-...'
export CCP_MOONSHOT_API_KEY='...'
```

Interactive storage avoids putting keys in shell history:

```bash
claude-code-proxy openai auth login
claude-code-proxy moonshot auth login

claude-code-proxy openai auth status
claude-code-proxy moonshot auth status
```

Add `--check` to verify the key against the provider's `/models` endpoint immediately:

```bash
claude-code-proxy openai auth login --check
claude-code-proxy moonshot auth login --check
```

Authentication precedence is:

1. `CCP_OPENAI_API_KEY` / `CCP_MOONSHOT_API_KEY`
2. `OPENAI_API_KEY` / `MOONSHOT_API_KEY`
3. `openai.apiKey` / `moonshot.apiKey` in `config.json`
4. macOS Keychain or the protected credential file created by `auth login`

### 3. Start the proxy

```bash
claude-code-proxy serve
```

Default address: `http://127.0.0.1:18765`.

```bash
PORT=11435 claude-code-proxy serve
claude-code-proxy serve --port 11435
```

### 4. Run Claude Code with OpenAI

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:18765 \
ANTHROPIC_AUTH_TOKEN=unused \
ANTHROPIC_MODEL='openai/gpt-5.6-sol[1m]' \
ANTHROPIC_SMALL_FAST_MODEL='openai/gpt-5.6-luna[1m]' \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 \
  claude
```

Bare GPT model IDs also route to OpenAI:

```bash
ANTHROPIC_MODEL='gpt-5.6-sol[1m]'
```

Appending `-fast` selects OpenAI's priority service tier while removing the suffix from the upstream model:

```bash
ANTHROPIC_MODEL='openai/gpt-5.6-sol-fast[1m]'
```

### 5. Run Claude Code with Moonshot/Kimi K3

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:18765 \
ANTHROPIC_AUTH_TOKEN=unused \
ANTHROPIC_MODEL='moonshot/kimi-k3[1m]' \
ANTHROPIC_SMALL_FAST_MODEL='moonshot/kimi-k3[1m]' \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 \
  claude
```

These aliases are equivalent:

```text
moonshot/kimi-k3
moonshot:kimi-k3
kimi-k3
k3
```

The `[1m]` suffix is a Claude Code context-window hint. The proxy strips it before sending the model ID upstream.

## Persistent Claude Code settings

Example `~/.claude/settings.json` for OpenAI:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18765",
    "ANTHROPIC_AUTH_TOKEN": "unused",
    "ANTHROPIC_MODEL": "openai/gpt-5.6-sol[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "openai/gpt-5.6-luna[1m]",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1"
  }
}
```

Change both model values to `moonshot/kimi-k3[1m]` for Kimi K3.

## Model routing

| Requested model | Provider | Upstream model |
|---|---|---|
| `openai/<id>` or `openai:<id>` | OpenAI Platform | `<id>` |
| bare `gpt-*`, `o*`, `chatgpt-*` | OpenAI Platform | unchanged |
| `moonshot/<id>` or `moonshot:<id>` | Moonshot | `<id>` |
| bare `kimi-*` | Moonshot | unchanged |
| `k3` | Moonshot | `kimi-k3` |
| `claude-*`, `haiku`, `sonnet`, `opus` | `aliasProvider` | provider default model |
| anything else | `defaultProvider` | requested ID |

Use explicit prefixes when the same model name exists through more than one vendor.

```bash
claude-code-proxy models
```

## Configuration

Initialize a safe template:

```bash
claude-code-proxy config init
claude-code-proxy config path
claude-code-proxy config show
```

Default paths:

- macOS/Linux: `${XDG_CONFIG_HOME:-$HOME/.config}/claude-code-proxy/config.json`
- Windows: `%APPDATA%\claude-code-proxy\config.json`
- override: `CCP_CONFIG_FILE=/path/config.json` or `CCP_CONFIG_DIR=/path`

Example:

```json
{
  "bindAddress": "127.0.0.1",
  "port": 18765,
  "defaultProvider": "openai",
  "aliasProvider": "openai",
  "requestTimeoutMs": 120000,
  "streamIdleTimeoutMs": 300000,
  "maxRequestBytes": 20971520,
  "maxResponseBytes": 67108864,
  "maxRetries": 2,
  "openai": {
    "baseUrl": "https://api.openai.com/v1",
    "defaultModel": "gpt-5.6-sol",
    "reasoningEffort": "high",
    "reasoningSummary": "auto",
    "encryptedReasoning": true,
    "serviceTier": "auto",
    "store": false
  },
  "moonshot": {
    "baseUrl": "https://api.moonshot.ai/v1",
    "defaultModel": "kimi-k3",
    "reasoningEffort": "max",
    "mergeSystemIntoUserForK3": false
  },
  "log": {
    "stderr": true,
    "verbose": false
  }
}
```

Environment variables override the matching file setting.

### Important environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `CCP_OPENAI_API_KEY` / `OPENAI_API_KEY` | unset | OpenAI Platform key |
| `CCP_MOONSHOT_API_KEY` / `MOONSHOT_API_KEY` | unset | Moonshot key |
| `CCP_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `CCP_MOONSHOT_BASE_URL` | `https://api.moonshot.ai/v1` | Moonshot-compatible base URL |
| `CCP_OPENAI_DEFAULT_MODEL` | `gpt-5.6-sol` | OpenAI default/alias model |
| `CCP_MOONSHOT_DEFAULT_MODEL` | `kimi-k3` | Moonshot default/alias model |
| `CCP_OPENAI_REASONING_EFFORT` | unset/file | OpenAI reasoning effort |
| `CCP_MOONSHOT_REASONING_EFFORT` | unset/file | K3 reasoning effort |
| `CCP_MOONSHOT_MERGE_SYSTEM` | `false` | Merge system instructions into the first user message for nonstandard K3-compatible gateways |
| `CCP_OPENAI_REASONING_SUMMARY` | `auto` | `auto`, `concise`, or `detailed` |
| `CCP_OPENAI_ENCRYPTED_REASONING` | `true` | Preserve stateless OpenAI reasoning across Claude Code tool turns |
| `CCP_OPENAI_SERVICE_TIER` | `auto` | `auto`, `default`, `flex`, or `priority` |
| `CCP_OPENAI_ORG_ID` / `OPENAI_ORG_ID` | unset | OpenAI organization header |
| `OPENAI_PROJECT_ID` | unset | OpenAI project header |
| `CCP_BIND_ADDRESS` | `127.0.0.1` | Listen address |
| `PORT` | `18765` | Listen port |
| `CCP_PROXY_AUTH_TOKEN` | unset | Required for non-loopback binding; also required before browser CORS can be enabled |
| `CCP_CORS_ORIGIN` | unset | Optional single allowed browser origin; disabled by default |
| `CCP_AUTH_STORE` | `auto` | `auto`, `keychain`, or `file` |
| `CCP_REQUEST_TIMEOUT_MS` | `120000` | Upstream header timeout |
| `CCP_STREAM_IDLE_TIMEOUT_MS` | `300000` | Upstream stream idle timeout |
| `CCP_MAX_RETRIES` | `2` | Pre-stream retry count |
| `CCP_LOG_VERBOSE` | `false` | Include request summaries and detailed diagnostics |
| `CCP_LOG_STDERR` | `true` | Mirror logs to stderr |

## Reasoning behavior

### OpenAI

Claude Code's `output_config.effort` is mapped to `reasoning.effort`. Supported values are accepted without silently downgrading:

```text
none, minimal, low, medium, high, xhigh, max
```

Visible OpenAI reasoning summaries are emitted as Anthropic `thinking` blocks. The request asks OpenAI for `reasoning.encrypted_content`; that opaque provider state is embedded in the block's Anthropic `signature` and replayed on a later tool turn when the upstream model still matches. The proxy never decrypts or invents reasoning. Model-mismatched, foreign, malformed, and oversized signatures are ignored instead of being sent upstream.

This behavior is enabled by default because the proxy defaults to `openai.store: false`. It can be disabled for a partial OpenAI-compatible gateway that rejects the `include` field:

```bash
CCP_OPENAI_ENCRYPTED_REASONING=0 claude-code-proxy serve
```

### Moonshot/Kimi K3

Effort mapping:

| Claude effort | K3 effort |
|---|---|
| `none`, `minimal`, `low` | `low` |
| `medium`, `high`, `xhigh` | `high` |
| `max` | `max` |

Streamed `reasoning_content` becomes Anthropic `thinking_delta` events. When the Anthropic request sets `thinking.type` to `disabled`, the proxy requests K3's lowest available effort (`low`), consumes any remaining reasoning output, and does not forward it to Claude Code.

Moonshot's public K3 Chat Completions endpoint accepts `system` messages, so the proxy preserves them by default. Some third-party K3-compatible gateways reject the `system` role; enable the compatibility rewrite only for those gateways:

```bash
CCP_MOONSHOT_MERGE_SYSTEM=1 claude-code-proxy serve
```

or set `moonshot.mergeSystemIntoUserForK3` to `true`.

## Claude Code inline system-message compatibility

Recent Claude Code builds can place `role: "system"` messages inside the positional `messages[]` array, including agent context and hook-provided reminders. The proxy accepts those messages, preserves their text, removes them from the conversational turn list, and appends them to the top-level system instructions before provider translation. `developer` messages receive the same treatment. Unknown roles still fail closed.

This prevents errors such as:

```text
API Error: 400 messages[1].role must be "user" or "assistant"
```

## Tool and image compatibility

- Anthropic tools become OpenAI function tools.
- `tool_choice` supports `auto`, `none`, `any`, and a named tool.
- `disable_parallel_tool_use` maps to `parallel_tool_calls`.
- assistant `tool_use` history becomes function calls.
- user `tool_result` history becomes function outputs/tool messages.
- OpenAI receives supported base64/data-URL and HTTPS image inputs through the Responses API.
- Moonshot K3 receives base64/data-URL images and rejects public HTTP(S) image URLs before the request leaves the machine, matching the first-party K3 API contract and avoiding proxy-side URL fetching.
- Moonshot tool-result images are moved into the following user vision message after their tool result, preserving K3-compatible ordering.
- OpenAI function outputs are text-only; tool-result images are represented by explicit placeholders rather than silently discarded.
- fragmented tool arguments are preserved as Anthropic `input_json_delta` events.

## Endpoints

### `POST /v1/messages`

Accepts Anthropic Messages JSON with `Content-Type: application/json` (or another `+json` media type). `stream: true` returns Anthropic SSE; `stream: false` returns an accumulated Anthropic message object.

### `POST /v1/messages/count_tokens`

Returns:

```json
{"input_tokens": 1234}
```

This is a conservative local estimate, not a billing total. It intentionally overweights CJK, emoji, images, JSON, and tool schemas so Claude Code compacts before an upstream context overflow.

### `GET /healthz`

No provider call and no API key required.

### `GET /models` and `GET /v1/models`

Show the configured routing defaults. The proxy does not fetch provider model catalogs on every request.

## Docker

Set provider keys and a separate local proxy token in the environment or an `.env` file that is not committed:

```bash
CCP_OPENAI_API_KEY='sk-...' \
CCP_MOONSHOT_API_KEY='...' \
CCP_PROXY_AUTH_TOKEN='a-long-random-local-token' \
  docker compose up --build
```

Use that same proxy token as `ANTHROPIC_AUTH_TOKEN` when Claude Code connects to the container.

The Compose service binds only to `127.0.0.1:18765` on the host by default.

## Exposing the proxy on a network

The server refuses to bind to a non-loopback address unless an inbound token is configured. The loopback listener also validates the `Host` header to reduce DNS-rebinding risk, and browser CORS is disabled unless an explicit origin and proxy token are both configured:

```bash
CCP_BIND_ADDRESS=0.0.0.0 \
CCP_PROXY_AUTH_TOKEN='a-long-random-local-token' \
  claude-code-proxy serve
```

Then set Claude Code's `ANTHROPIC_AUTH_TOKEN` to the same token. The proxy accepts it through `x-api-key` or `Authorization: Bearer`.

Use TLS at a reverse proxy for any traffic that leaves the machine.

To permit one browser origin, configure both controls:

```bash
CCP_PROXY_AUTH_TOKEN='a-long-random-local-token' \
CCP_CORS_ORIGIN='https://trusted.example' \
  claude-code-proxy serve
```

Wildcard CORS is not supported. Normal Claude Code CLI traffic does not require CORS.

## Tests

Everything except live provider calls is tested offline with deterministic mock OpenAI and Moonshot servers:

```bash
npm run check
npm test
npm run test:coverage
```

The test suite covers:

- configuration and key precedence
- protected credential storage
- model routing and context suffix stripping
- OpenAI request and SSE translation
- encrypted OpenAI reasoning signature round-trips and model-switch safety
- Moonshot/K3 request and SSE translation
- reasoning, text, function calls, fragmented JSON, cache usage, and terminal events
- local token estimation
- full proxy HTTP integration against mock providers
- strict stream-terminal validation and truncated-stream rejection
- JSON content-type, loopback `Host`, CORS, body-limit, and inbound-auth hardening
- missing-auth error behavior

Live API calls are intentionally excluded so tests never consume paid tokens or require secrets in CI.

## Operational limitations

- This uses paid API billing, not ChatGPT/Kimi subscription entitlements.
- OpenAI encrypted reasoning is provider-, account-, and model-scoped. A key/account change can make an older signature unusable; model changes are detected locally and the stale state is dropped.
- The local token counter is an estimate.
- The proxy does not automatically inject hosted web-search tools. Claude Code's client-side tools continue to work normally.
- A provider may reject a model or parameter that is not enabled for your account; the upstream error is preserved in Anthropic error form.
- Transparent retry occurs only before a successful upstream stream is handed to the response translator. Retrying after semantic output could duplicate text or tool execution and is deliberately avoided.
- The packaged release is validated with deterministic mock upstreams. Live paid OpenAI/Moonshot calls require your own keys and are not executed by the archive test suite.

## License

MIT. The upstream project's authorship and provenance are retained in [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
# claude-code-proxy

