# azupic

**azupic** — небольшой Go-мост между Anthropic Messages API, используемым Claude Code, и Azure OpenAI Responses API. Один бинарник, стандартная библиотека Go, явный endpoint и deployment. Версия 0.1 проверена mock-тестами и короткой реальной беседой Claude Code через Azure Responses с thinking и повторными ходами. Исполнение локальных tools, интерактивное переключение effort и compaction пока проверены только частично или ожидают live-проверки.

## Сборка и запуск

Требуется Go 1.24 или новее.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# AZURE_OPENAI_API_KEY должен быть задан в окружении.
export REASONING_EFFORT=high
./bin/azupic
```

Допустим и полный dated URL: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. Мост отправляет URL буквально; `deployment` находится в поле `model` запроса. После 404 протокол и URL не перебираются. HTTP разрешён только для mock upstream на loopback.

В другом терминале:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

Входное имя модели по умолчанию всегда переводится в `AZURE_DEPLOYMENT`. Не нужно называть Azure модель Claude-моделью или добавлять суффикс `[1m]`. Если Claude Code настроен на другой auth/provider, используйте отдельный профиль клиента и явно выбранную авторизацию для локального endpoint.

## Конфигурация

После задания `AZURE_RESPONSES_URL` готовый запуск azupic и Claude Code с deployment `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

Скрипт задаёт переменные только своим процессам, использует существующий `AZURE_OPENAI_API_KEY`, запускает мост на `127.0.0.1:8080` и останавливает его после выхода из Claude. Лог: `.local/azupic.log`. Другой deployment можно выбрать через `AZUPIC_DEPLOYMENT`. Аргументы передаются Claude, например `bash scripts/run-claude.sh -p 'Ответь одним словом: OK'`. Нужны `curl` и разрешение среды на локальные TCP-сокеты.

| Переменная | Значение |
| --- | --- |
| `AZURE_RESPONSES_URL` | Обязательный полный URL Responses |
| `AZURE_DEPLOYMENT` | Обязательное имя Azure deployment |
| `AZURE_OPENAI_DEPLOYMENT` | Альтернативное имя для `AZURE_DEPLOYMENT`; если заданы оба, значения должны совпадать |
| `AZURE_OPENAI_API_KEY` | Обязательный upstream credential |
| `AZURE_AUTH_MODE` | `api-key` по умолчанию; `bearer` для явно заданного bearer credential, без обновления Entra token |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Отдельный клиентский токен; обязателен вне loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, например `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Опционально: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; фактическая поддержка зависит от deployment |
| `AZUPIC_BODY_LIMIT` | Размер входа в байтах, по умолчанию 20 MiB |
| `AZUPIC_RESPONSE_LIMIT` | Размер upstream SSE в байтах, по умолчанию 64 MiB |
| `AZUPIC_TIMEOUT` | Общий лимит генерации, по умолчанию `10m` |
| `AZUPIC_IDLE_TIMEOUT` | Ожидание данных upstream и записи downstream, по умолчанию `5m` |

Входной токен принимается через `x-api-key` или `Authorization: Bearer`. Не используйте для него Azure key. Для публичного доступа обеспечьте TLS перед мостом.

## Поддержка протокола

`POST /v1/messages` возвращает Anthropic JSON или SSE по полю `stream`. Query `?beta=true` поддерживается. Upstream всегда использует Responses SSE. Inline system/developer text messages сохраняют роль и позицию в истории. Текст, отказ модели, обычные function tools, tool results, user images и images в tool results переводятся с сохранением порядка истории. Произвольные вложенные tool schemas сохраняются. Исполнение Read, Edit, Bash и MCP tools остаётся в Claude Code.

Encrypted reasoning переносится в `thinking.signature` через envelope `azupic:responses:v1:`. Envelope привязан к полному URL, deployment и credential; смена конфигурации требует новой сессии. Это контейнер для зашифрованного provider state, а не криптографическая подпись. Если Azure не возвращает encrypted state, мост сообщает ошибку. Обычные повторные ходы работают в live-сессии; replay в полном tool cycle и поведение compaction требуют live-проверки.

`max_tokens` переводится в `max_output_tokens`, который включает reasoning. `output_config.effort`, затем `thinking.effort`, затем `REASONING_EFFORT` определяют effort. `thinking.budget_tokens` принимается как подсказка клиента без перевода отдельного бюджета. `thinking.type=disabled` не гарантирует отключения Azure reasoning: действует выбранный effort, полученный summary сохраняется для replay.

`output_config.format` с JSON schema переводится в Responses structured output. Anthropic cache breakpoints и metadata не отправляются upstream. Cached input считается отдельно: Azure input=100/cached=60 → Anthropic input=40/cache_read=60. Reasoning output повторно не прибавляется.

Native hosted tools, deferred tool search, `tool_reference`, documents, роли кроме user/assistant/system/developer и неизвестные content blocks отклоняются с HTTP 400. `stop_sequences`, `top_p`, `top_k` не поддерживаются; пустые `stop_sequences` и default `temperature=1` допустимы. В `context_management.edits` допустимы `clear_thinking_20251015` и `clear_tool_uses_20250919`: мост сохраняет полную историю, логирует отсутствие очистки и не заявляет применённых edits. Это позволяет сохранить Responses reasoning replay; серверная очистка Anthropic не реализована. Другие стратегии, включая server-side compaction, отклоняются. Неизвестный semantic output Azure вызывает ошибку. Это начальная совместимость, а не полная реализация Anthropic API.

`POST /v1/messages/count_tokens` считает приблизительно по преобразованному запросу, включая schemas и signatures, с ответным заголовком `x-azupic-token-count: estimate`. Это не tokenizer Azure и не гарантия вместимости контекста; image tokens также оцениваются неточно. `GET /healthz` проверяет только процесс.

HTTP ошибки Azure сохраняют status и `Retry-After`, без содержимого upstream body. Ошибки после начала SSE идут событием `error` без успешного `message_stop`. Обрыв до terminal event считается ошибкой. Автоматических повторов POST нет. Отмена клиента закрывает upstream. Логи содержат endpoint с замаскированными query параметрами, deployment, status и `apim-request-id`, без ключей и истории.

## Изменение effort

Для запуска из любой папки добавьте в `~/.bashrc` строку `source /path/to/azupic/scripts/bash-integration.sh`. После перезагрузки shell появится команда `claude-az`, например `claude-az --effort high`. Она запускает мост и Claude из текущей рабочей папки, очищая унаследованные настройки других провайдеров в subshell. Настройки родительского терминала сохраняются.

Скрипт включает `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` для имени `azupic` и убирает фиксированный `CLAUDE_CODE_EFFORT_LEVEL`, чтобы он не перекрывал интерактивную настройку. Начальный уровень можно передать как `bash scripts/run-claude.sh --effort high`. В работающем Claude используйте `/effort low`, `/effort medium`, `/effort high` или `/effort xhigh`. Новое значение применяется при следующем запросе без перезапуска azupic. Azure deployment должен поддерживать выбранный уровень.

Claude `max` переводится в Azure `xhigh`; остальные уровни передаются напрямую. `/effort auto` снимает выбор клиента: мост использует `REASONING_EFFORT`, если он задан при запуске, иначе default Azure. Лог `.local/azupic.log` содержит `generation request` с `reasoning_effort`. Изменение effort не меняет scope reasoning signature. Интерактивную передачу effort реальным Claude ещё нужно подтвердить по этим логам.

## Проверки

```sh
go test -race ./...
go vet ./...
```

Тесты используют настоящий HTTP/1.1 через `net.Pipe`, поэтому не требуют TCP-портов или Azure. Проверяются tool/reasoning replay, call IDs, порядок истории, параллельные tools, задержанное имя, повреждённый JSON, несовпадение streamed/final arguments, дедупликация финального текста, usage, max_tokens, неизвестные capabilities, CRLF/UTF-8 на всех split points, literal URL и auth, HTTP 404/429, EOF, idle timeout и отмена клиента.

Источник исследования: [контракт](docs/anthropic-azure-responses-contract.md) и MIT snapshot [dywongcloud/claude-code-proxy](reference/SOURCE.json). Go-код написан отдельно; reference оставлен без исправлений. Требование replay reasoning при tools описано в [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
