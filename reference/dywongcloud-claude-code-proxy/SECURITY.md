# Security

## Secret handling

Authentication precedence is environment, config file, then stored credentials.

- On macOS, interactive credentials use Keychain by default.
- On Linux and Windows, the fallback credential file lives under the user's configuration directory. POSIX systems receive mode `0600`; parent directories receive mode `0700`.
- `CCP_AUTH_STORE=file` forces file storage.
- `CCP_AUTH_STORE=keychain` forces Keychain and is valid only on macOS.
- Logs redact keys whose field names contain authorization, token, secret, password, cookie, or API key.
- The source archive contains no API keys.

OpenAI stateless reasoning is returned by the provider as encrypted opaque data. When enabled, the proxy stores that blob inside the Anthropic thinking `signature` sent to Claude Code so a subsequent tool turn can replay it. It is not plaintext reasoning and the proxy does not decrypt it, but it can remain in local Claude Code session history. Protect those histories as you would other model transcripts.

The macOS `security` command receives the key during storage. As with many command-line Keychain integrations, the value can briefly be observable to a sufficiently privileged local process. Environment variables are also visible to processes with appropriate inspection privileges. Use a dedicated machine/account and least-privilege provider keys for high-sensitivity environments.

## Network exposure

The default bind address is loopback. A non-loopback bind is rejected unless `CCP_PROXY_AUTH_TOKEN` is set. This token authenticates clients to the local proxy; it is separate from provider keys.

The loopback listener validates the `Host` header and rejects non-loopback hostnames when no inbound proxy token is configured, reducing DNS-rebinding exposure. Browser CORS is disabled by default. `CCP_CORS_ORIGIN` permits exactly one HTTP(S) origin and is accepted only when `CCP_PROXY_AUTH_TOKEN` is also configured; wildcard CORS is intentionally unsupported.

POST endpoints require `Content-Type: application/json` or another `+json` media type. This prevents a cross-origin browser form submission from becoming a simple request to the unauthenticated loopback service.

The proxy does not terminate TLS. Put it behind a trusted TLS reverse proxy before sending traffic across a network.

## Request controls

- request body limit: 20 MiB by default
- response stream limit: 64 MiB by default
- upstream header timeout: 120 seconds
- upstream idle timeout: 300 seconds
- bounded retries before stream commitment
- no retry after semantic output is exposed
- strict terminal-event validation for provider streams
- response writes honor downstream backpressure
- logs contain bounded summaries, never complete prompts or tool payloads

## Reporting

Do not include API keys, request bodies containing confidential source code, or credential files in a vulnerability report.

