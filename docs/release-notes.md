# azupic 0.1.0

Initial release of the Go bridge from Claude Code's Anthropic Messages API to Azure OpenAI Responses.

- Streaming and JSON responses, ordered function tools and encrypted reasoning replay.
- Explicit endpoint, deployment, authentication and model aliases.
- Per-request reasoning effort, correct cached-token accounting and cancellation.
- Loopback defaults, bounded requests and responses, and no automatic generation retries.
- Standalone binaries for Linux, macOS and Windows on amd64 and arm64, with SHA-256 checksums.

Download `.tar.gz` for Linux/macOS or `.zip` for Windows. Each archive contains the binary, MIT license and English, Russian, Ukrainian, Slovak, Danish and Belarusian READMEs. Verify it against `checksums.txt` before use. macOS binaries are unsigned and not notarized; Windows binaries are unsigned.

Go is needed only to build from source. Configure `AZURE_RESPONSES_URL`, `AZURE_OPENAI_API_KEY` and `AZURE_DEPLOYMENT` (or `AZURE_OPENAI_DEPLOYMENT`), then start the binary. Point Claude Code's `ANTHROPIC_BASE_URL` at the bridge.

Mock tests and a short real Claude Code conversation through Azure Responses have passed. Full live tool execution, interactive effort changes and compaction need further validation. Native hosted tools, deferred tool search and server-side compaction are unsupported; see README for the compatibility policy.
