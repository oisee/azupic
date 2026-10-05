# Changelog

## 1.0.1 — 2026-08-20

- Fixed Claude Code 2.1.154+ compatibility when the client emits positional `system` messages inside `messages[]`.
- Added validation support for inline `system` and `developer` roles, then safely hoisted their text into the top-level Anthropic `system` field before OpenAI or Moonshot translation.
- Added end-to-end OpenAI and Moonshot regression coverage for the exact `messages[1].role` failure.

## 1.0.0 — 2026-08-19

- Added first-class OpenAI Platform API-key provider using the Responses API.
- Added first-class Moonshot API-key provider with Kimi K3 Chat Completions support.
- Added Anthropic Messages request/response translation, streaming SSE, reasoning, tools, images, usage, and structured errors.
- Added OpenAI `reasoning.encrypted_content` preservation in Anthropic thinking signatures for stateless tool-call continuation, with model-switch rejection and gateway opt-out.
- Added environment, config-file, macOS Keychain, and protected credential-file authentication.
- Added collision-safe `openai/` and `moonshot/` model routing.
- Added local token estimation, health/model endpoints, retries, header/post-header idle timeouts, heartbeats, redacted summary-only logs, body limits, downstream backpressure, and inbound auth for network binds.
- Preserved first-party Moonshot K3 `system` messages by default, with an explicit compatibility merge switch for nonstandard gateways.
- Added Moonshot K3 public-image URL rejection, strict stream terminal validation, JSON content-type enforcement, closed-by-default CORS, and loopback Host/DNS-rebinding defenses.
- Added Docker, Compose, installer, CI, migration documentation, and deterministic mock-provider tests.

