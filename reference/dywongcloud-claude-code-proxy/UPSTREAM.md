# Upstream provenance

This project is an API-key-focused, dependency-free implementation of the Anthropic-compatible proxy interface established by:

- Repository: `raine/claude-code-proxy`
- Upstream main inspected: `dc61029dfdea54fda7367d064885aaceb8d1ac80`
- Upstream release at inspection time: `v0.1.35`
- Inspection date: 2026-08-19
- License: MIT

The upstream project is Rust-based and supports several OAuth/subscription providers. This downloadable edition is a clean API-key implementation with the same user-facing local endpoint contract, not a byte-for-byte copy of upstream main. It focuses only on the requested OpenAI Platform and Moonshot/Kimi K3 API-key paths.

No upstream OAuth client credentials, tokens, or private implementation data are included.

