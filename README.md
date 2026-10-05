# azupic

[Русская версия](README.RU.md)

**azupic** is a small Go bridge from the Anthropic Messages API used by Claude Code to Azure OpenAI Responses. One binary, the Go standard library, an explicit endpoint and deployment. Version 0.1 has been tested with local mocks and a short real Claude Code conversation through Azure Responses, including thinking and follow-up turns. Local tool execution, interactive effort changes and compaction still need further live validation.

## Downloads and releases

Prebuilt binaries are provided for Linux, macOS and Windows, each on amd64 and arm64. Download an archive and `checksums.txt` from [GitHub Releases](https://github.com/oisee/azupic/releases). Archives contain the binary, license and both READMEs. macOS and Windows binaries are unsigned.

Build all six locally with `python3 scripts/build-release.py v0.1.0`; output goes to `dist/`. CI builds the same archives on pushes and pull requests. Pushing a version tag runs tests, builds and checksums all targets, uploads to a draft release and publishes after every upload succeeds. The workflow can also be dispatched for an existing tag.

## Build and run

Requires Go 1.24 or newer.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# Set AZURE_OPENAI_API_KEY in your environment.
export REASONING_EFFORT=high
./bin/azupic
```

A full dated URL also works: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. The bridge uses the URL literally and sends the deployment in the request's `model` field. It does not try alternative URLs or protocols after a 404. HTTP upstreams are allowed only on loopback for local mocks.

In another terminal:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

By default, every incoming model name maps to `AZURE_DEPLOYMENT`. You do not need to name an Azure model after a Claude model or append `[1m]`. If Claude Code uses another authentication mode or provider, use a separate client profile with explicit authentication for the local endpoint. Avoid setting both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.

## Configuration

After setting `AZURE_RESPONSES_URL`, launch both the bridge and Claude Code with deployment `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

The script sets environment variables for its own processes, uses the existing `AZURE_OPENAI_API_KEY`, starts the bridge on `127.0.0.1:8080` and stops it when Claude exits. Logs go to `.local/azupic.log`. Choose another deployment with `AZUPIC_DEPLOYMENT`. Arguments are passed to Claude, for example `bash scripts/run-claude.sh -p 'Reply with one word: OK'`. Requires `curl` and permission to open local TCP sockets.

| Variable | Purpose or default |
| --- | --- |
| `AZURE_RESPONSES_URL` | Required full Responses URL |
| `AZURE_DEPLOYMENT` | Required Azure deployment name |
| `AZURE_OPENAI_DEPLOYMENT` | Alternative to `AZURE_DEPLOYMENT`; if both are set, values must match |
| `AZURE_OPENAI_API_KEY` | Required upstream credential |
| `AZURE_AUTH_MODE` | `api-key` by default; `bearer` for an explicitly supplied bearer credential, without Entra token refresh |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Separate client token; required when listening outside loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, e.g. `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Optional: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; deployment support varies |
| `AZUPIC_BODY_LIMIT` | Incoming body limit in bytes; 20 MiB by default |
| `AZUPIC_RESPONSE_LIMIT` | Upstream SSE limit in bytes; 64 MiB by default |
| `AZUPIC_TIMEOUT` | Total generation timeout; `10m` by default |
| `AZUPIC_IDLE_TIMEOUT` | Upstream read and downstream write idle timeout; `5m` by default |

Client tokens are accepted through `x-api-key` or `Authorization: Bearer`. Use a separate token from the Azure key. Put TLS in front of the bridge if exposing it publicly.

## Protocol support

`POST /v1/messages` returns Anthropic JSON or SSE according to `stream`. The `?beta=true` query is supported. Upstream requests always use Responses SSE. Inline system/developer text messages retain their role and position. Text, refusals, ordinary function tools, tool results, user images and images in tool results preserve history order. Nested tool schemas are retained. Claude Code executes Read, Edit, Bash and MCP tools.

Encrypted reasoning is carried in `thinking.signature` using an `azupic:responses:v1:` envelope scoped to the full URL, deployment and credential. Changing those settings requires a new session. The envelope contains encrypted provider state; it is not a cryptographic signature. Missing encrypted state is an error. Ordinary follow-up turns work in a live session; replay through a full tool cycle and compaction still need live validation.

`max_tokens` maps to `max_output_tokens`, which includes reasoning. Effort priority is `output_config.effort`, then `thinking.effort`, then `REASONING_EFFORT`. `thinking.budget_tokens` is accepted as a client hint without translating a separate budget. `thinking.type=disabled` does not guarantee that Azure reasoning is disabled: the selected effort applies, and returned summaries are retained for replay.

`output_config.format` with a JSON schema maps to Responses structured output. Anthropic cache breakpoints and metadata are not forwarded. Cached input is accounted for separately: Azure input=100/cached=60 becomes Anthropic input=40/cache_read=60. Reasoning output is not added twice.

Native hosted tools, deferred tool search, `tool_reference`, documents, roles other than user/assistant/system/developer and unknown content blocks return HTTP 400. `stop_sequences`, `top_p` and `top_k` are unsupported; empty `stop_sequences` and default `temperature=1` are accepted. `context_management.edits` accepts `clear_thinking_20251015` and `clear_tool_uses_20250919`, but retains the full history, logs that clearing was not applied and never claims applied edits. This preserves Responses reasoning replay; Anthropic server-side clearing is not implemented. Other strategies, including server-side compaction, are rejected. Unknown semantic Azure output is an error. This is initial compatibility, not a complete Anthropic API implementation.

`POST /v1/messages/count_tokens` estimates tokens from the transformed request, including schemas and signatures, with response header `x-azupic-token-count: estimate`. It is not an Azure tokenizer or a guarantee that a request fits the context window; image estimates are also imprecise. `GET /healthz` checks the process only.

Azure HTTP errors preserve the status and `Retry-After`, without forwarding the upstream error body. Errors after SSE starts produce an `error` event without a successful `message_stop`. EOF before a terminal event is an error. POST requests are never automatically retried. Client cancellation closes upstream requests. Logs contain the endpoint with redacted query parameters, deployment, status and `apim-request-id`, without keys or conversation history.

## Change reasoning effort

To launch from any directory, add `source /path/to/azupic/scripts/bash-integration.sh` to `~/.bashrc`. Reload your shell to use `claude-az`, for example `claude-az --effort high`. It starts the bridge and Claude in your current working directory and clears inherited provider settings in a subshell, preserving the parent terminal's environment.

The launcher enables `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for the custom `azupic` model and unsets fixed `CLAUDE_CODE_EFFORT_LEVEL` so it does not override interactive changes. Start with `bash scripts/run-claude.sh --effort high`. During a session, use `/effort low`, `/effort medium`, `/effort high` or `/effort xhigh`. The new value applies to the next request without restarting azupic. Your Azure deployment must support the selected level.

Claude `max` maps to Azure `xhigh`; other levels pass through. `/effort auto` clears the client selection: the bridge uses its startup `REASONING_EFFORT`, if set, or Azure's default. `.local/azupic.log` records `generation request` with `reasoning_effort`. Effort changes do not alter the reasoning signature scope. Interactive effort transmission from the real Claude client still needs confirmation in these logs.

## Checks

```sh
go test -race ./...
go vet ./...
```

Tests use real HTTP/1.1 over `net.Pipe`, requiring neither TCP ports nor Azure. They cover tool/reasoning replay, call IDs, history order, parallel tools, delayed names, invalid JSON, streamed/final argument disagreement, final text deduplication, usage, max_tokens, unsupported capabilities, CRLF/UTF-8 at every split point, literal URLs and authentication, HTTP 404/429, EOF, idle timeouts and client cancellation.

Research sources: the [contract (Russian)](docs/anthropic-azure-responses-contract.md) and MIT [dywongcloud/claude-code-proxy snapshot](reference/SOURCE.json). The Go implementation was written separately; the reference snapshot remains unpatched. The reasoning replay requirement for tools is described in the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
