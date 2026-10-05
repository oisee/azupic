# Migration from OAuth-based claude-code-proxy

This edition replaces subscription OAuth providers with first-party API-key providers.

## Command changes

| OAuth edition | API-key edition |
|---|---|
| `claude-code-proxy codex auth login` | `claude-code-proxy openai auth login` |
| `claude-code-proxy kimi auth login` | `claude-code-proxy moonshot auth login` |
| ChatGPT subscription backend | OpenAI Platform `POST /v1/responses` |
| Kimi Code subscription backend | Moonshot `POST /v1/chat/completions` |

Stored OAuth tokens are not read, modified, or deleted by this edition.

## Model changes

Use explicit provider prefixes to prevent accidental routing collisions:

```text
openai/gpt-5.6-sol
moonshot/kimi-k3
```

Bare `gpt-*` and `kimi-*` names remain convenient aliases.

## Environment changes

Remove any dependency on OAuth login and configure:

```bash
export OPENAI_API_KEY='sk-...'
export MOONSHOT_API_KEY='...'
```

Existing Claude Code proxy variables remain the same:

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:18765'
export ANTHROPIC_AUTH_TOKEN='unused'
```

## Billing change

Requests are billed by the OpenAI Platform or Moonshot API account associated with the key. They do not consume ChatGPT Plus/Pro or Kimi Code subscription quota.

## Moonshot K3 system and image behavior

The first-party Moonshot K3 API accepts `system` messages, so this edition preserves them. Set `CCP_MOONSHOT_MERGE_SYSTEM=1` only for a third-party K3-compatible endpoint that rejects the role. Moonshot K3 image inputs must be embedded data/base64; public HTTP(S) image URLs are rejected locally.

