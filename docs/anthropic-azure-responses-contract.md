# Контракт Anthropic Messages и Azure Responses

Разбор фиксирует поведение исходников dywongcloud/claude-code-proxy и требования к нашему Go-мосту. Полезная основа проекта — перевод истории, нормализация Responses SSE и перенос encrypted reasoning через thinking signature. Transport и несколько permissive fallback требуют изменения. Совместимость с настоящими Claude Code и Azure пока не проверена.

## Источник и воспроизводимость

Snapshot: `reference/dywongcloud-claude-code-proxy`, commit `c072e961d5ad5bab72dbb7594707e73fa89acad4`, получен 5 октября 2026 года через GitHub connector. Это копия всех 57 файлов дерева, без Git metadata; завершающие переводы строк могут быть нормализованы. MIT LICENSE и copyright сохранены. Метаданные: `reference/SOURCE.json`.

Главные файлы:

| Файл в snapshot | Назначение |
| --- | --- |
| `src/anthropic.js` | Валидация входа, hoisting инструкций, Anthropic SSE encoder и JSON accumulator |
| `src/providers/openai.js` | Transport, перевод запроса и Responses SSE/JSON в нормализованные события |
| `src/providers/common.js` | Tools, tool choice, effort, metadata, usage |
| `src/reasoning-signature.js` | Envelope encrypted reasoning и обратный replay |
| `src/sse.js` | Разбор SSE через границы сетевых chunks |
| `src/http.js` | HTTP, retry до возврата успешного upstream response, timeout и лимиты |
| `src/server.js` | HTTP endpoints, отмена, pings, backpressure и ошибки |
| `src/router.js` | Эвристики провайдера, aliases и stripping context suffix |
| `test/openai.test.js` | Шесть тестов Responses: request, JSON, reasoning, SSE, позднее имя tool, обрыв |

Проверки: `npm run check` проходит. 29 тестов в шести доступных test-файлах проходят. Четыре оставшихся test-файла не загружаются: `server.js` и `tokenhub.test.js` импортируют отсутствующий `src/providers/tokenhub.js`; соответствующая реализация находится в `src/providers/anthropic.js`. Это дефект исходного snapshot, а не потеря при скачивании. Snapshot оставлен без исправлений.

Повторить доступные тесты из snapshot:

```sh
npm run check
node --test --test-isolation=none --test-reporter=spec test/openai.test.js test/anthropic-validation.test.js test/anthropic-tokens.test.js test/router.test.js test/moonshot.test.js test/monitor.test.js
```

Дополнительный offline разбор из корня workspace:

```sh
node scripts/inspect-reference-contract.mjs
```

Он создаёт `docs/fixtures/messages-responses-tool-cycle.json`: Messages request, Responses request, полный набор synthetic SSE, нормализованные события, Anthropic response и следующий запрос с tool result. Реальная модель не вызывается; `gpt-6.1-sol` здесь только строка deployment. `reference-observations.json` сохраняет воспроизведённые ограничения. Fixtures показывают поведение reference, а не обязательные ожидаемые результаты будущего Go-кода.

## Входной HTTP контракт

| Метод и путь | Поведение reference |
| --- | --- |
| `POST /v1/messages` | Messages JSON, `stream: true` даёт Anthropic SSE; иначе JSON |
| `POST /v1/messages?beta=true` | Тот же обработчик: routing проверяет pathname |
| `POST /v1/messages/count_tokens` | Локальная оценка; не вызывает provider и не требует upstream key |
| `GET /healthz` | Проверяет сам процесс, не доступность Azure |
| `GET /models`, `GET /v1/models` | Конфигурационный каталог, не live discovery |

JSON media type обязателен для POST. При настроенном proxy token принимается `x-api-key` или bearer. Ключ клиента и ключ Azure — разные сущности. На loopback token необязателен; вне loopback reference требует его. POST имеет body limit 20 MiB по умолчанию. Все ответы получают локальный request ID.

Валидация reference требует непустой `model`, массив `messages`, строку или массив content в каждом message. `max_tokens`, если присутствует, должен быть положительным integer; `stream`, если присутствует, boolean. `max_tokens` не обязателен даже для генерации. Разрешены user/assistant/system/developer. Проверки block fields и JSON schemas поверхностные; неизвестные поля остаются во входе.

System/developer messages внутри `messages[]` удаляются из позиции и добавляются в конец top-level system. При массиве system блоки сохраняются, при строке объединяются с двойным newline. Это меняет позиционную семантику инструкций: для Go нужно явно выбрать поддерживаемый вариант после захвата настоящих запросов Claude Code.

## Перевод запроса

| Anthropic | Responses в reference | Решение для Go |
| --- | --- | --- |
| `model` | `route.model` | Явная таблица alias → deployment; никакого угадывания протокола |
| top-level `system` | `instructions`, text blocks объединены через `\n\n` | Сохранить текст и порядок поддерживаемых инструкций |
| `messages` | Последовательность `input` items | Не группировать все calls или outputs отдельно от текста |
| `max_tokens` | `max_output_tokens` | Явная политика: лимит Responses включает reasoning; бюджеты не эквивалентны |
| `stream` | Upstream всегда `true` | Можно использовать SSE для обоих downstream режимов |
| custom `tools` | function tools, `parameters=input_schema`, `strict:false` | Сохранять произвольную вложенную схему; проверить допустимые имена |
| `tool_choice.type=auto/none/any` | `auto/none/required` | Сохранить |
| `tool_choice.type=tool` | `{type:"function",name}` | Проверять наличие tool |
| `disable_parallel_tool_use` | Инверсия в `parallel_tool_calls` | Явный boolean имеет приоритет в reference |
| `output_config.effort` | `reasoning.effort` | Конфигурация должна явно определять приоритет относительно client effort |
| `thinking.effort` | Effort fallback после output_config | Не путать с budget_tokens |
| `thinking.type=disabled` | Поле reasoning отсутствует | Не гарантирует выключение upstream reasoning или скрытие summary |
| `output_config.format` | `text.format`, JSON object/schema | Проверять capability и schema; ошибки не маскировать |
| `metadata` | До 16 scalar values, строки key ≤64/value ≤512 | Служебные данные не нужны upstream автоматически |
| session header / metadata.session_id | `prompt_cache_key`, первые 64 символа | Для Go лучше стабильный hash и явная область endpoint/deployment |
| `cache_control` | Не переносится | Anthropic cache breakpoints не эквивалентны Azure caching |
| `thinking.budget_tokens`, temperature, top_p, stop_sequences, context_management | Не переводятся | Нужна документированная allowlist игнорируемых полей и ошибки для существенных неподдерживаемых возможностей |

Приоритет session key в translator: `x-claude-code-session-id`, `x-session-id`, `metadata.session_id`. Effort: `output_config.effort`, `thinking.effort`, config. Разрешённый список effort общий; фактическую поддержку deployment reference не устанавливает.

`previous_response_id` и `conversation` не используются. `store:false` по умолчанию. История передаётся целиком клиентом; прокси не хранит глобальную историю. Это удобная основа для параллельных Claude сессий и рестартов.

## История сообщений и tools

User text → message/user/input_text. User image → input_image с data URL либо URL. Перед tool_result накопленный user text/image сбрасывается в отдельный message, затем добавляется function_call_output, затем снова может идти user message. `is_error:true` превращается в текстовый префикс `[tool error]\n`.

Assistant text → message/assistant/output_text. Перед tool_use накопленный текст сбрасывается, затем добавляется function_call с `call_id=tool_use.id`, `name` и JSON-строкой `arguments`. Thinking/redacted_thinking при корректной signature превращается в reasoning item в той же позиции истории.

Критический invariant:

```text
Responses function_call.call_id
    = Anthropic tool_use.id
    = Anthropic tool_result.tool_use_id
    = Responses function_call_output.call_id
```

`function_call.id` — другой идентификатор, для самого output item. Нельзя путать его с `call_id` при переводе результатов.

Прокси не запускает tools. Bash, Read, Edit, MCP tools исполняет Claude Code, а прокси переносит definitions, вызов и result. Native Anthropic hosted tools требуют отдельного mapping либо явной ошибки: reference превращает даже web_search без input_schema в function tool без parameters. Это не реализует hosted search.

Reference заменяет images в tool outputs текстовыми placeholders. Text documents превращаются в input_text, другие documents — в placeholder. Неизвестные input blocks сериализуются как текст. Наш bridge должен явно поддерживать image/document/tool_reference варианты, которые реально приходят от харнесса; остальные блоки отклонять, а не представлять JSON как содержание разговора.

## Responses SSE и внутренние события

Reference отделяет provider parser от Anthropic encoder. Внутренняя модель событий компактная:

```text
block_start(key, kind=text|thinking|tool, id?, name?)
block_delta(key, deltaType=text|thinking|json, delta)
block_stop(key, signature?)
usage(input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
message_done(stopReason)
error(error)
```

| Responses event | Нормализованное действие |
| --- | --- |
| created/in_progress/queued | Lifecycle игнорируется |
| reasoning summary/text delta | Открыть thinking block и добавить delta |
| reasoning summary/text done | Дополнить при отсутствии deltas; block оставить открытым до полного reasoning item |
| output_text/refusal delta | Открыть text block, добавить text |
| output_text/refusal done | Fallback на полный text только если deltas не было, закрыть block |
| output_item.added с function_call | Запомнить item ID/call ID/name и открыть tool, когда name известен |
| function_call_arguments.delta | Накопить строку; после известного name отдавать только ещё не отданный суффикс |
| function_call_arguments.done | Сверить полный arguments по длине, отдать оставшийся суффикс и закрыть |
| output_item.done | Fallback/закрытие message, function_call или reasoning, signature из encrypted_content |
| completed | Обработать финальные output items без повторения уже отданного текста; закрыть blocks; usage; message_done |
| incomplete с max_output_tokens | Аналогично финализировать, stop reason max_tokens |
| incomplete с другим reason, failed, error | Ошибка |
| EOF или [DONE] до terminal event | Ошибка, не успешное завершение |

Text blocks индексируются по item ID и content_index; reasoning — по item ID; tool state — по item ID с call_id отдельно. Параллельные tool calls требуют отдельных накопителей. Полный terminal output нужен для encrypted reasoning и fallback; нельзя дважды отдать текст из delta и completed.

Ограничения: arguments сверяются по длине, а не по совпадению prefix; reference допускает fabricated name `tool` и `{}` при незавершённом state. Неизвестные output item types молча пропускаются. Для Go нужны проверки неизменности ID/name, согласованности final arguments и явная обработка неизвестного semantic output. Неизвестную телеметрию можно игнорировать.

## Anthropic SSE и JSON

Encoder создаёт новый message ID и последовательные индексы blocks. Response model — resolved upstream model, а не входной Claude alias. Форма успешного downstream потока:

```text
message_start
  content_block_start
  content_block_delta (text_delta | thinking_delta | input_json_delta)
  content_block_delta (signature_delta для thinking перед закрытием)
  content_block_stop
  ... другие blocks ...
message_delta (stop_reason, cumulative usage)
message_stop
```

Pings не меняют message state. На ошибке после HTTP 200 — in-band `error`, завершение соединения без fake success. Backpressure: await drain при заполнении downstream buffer. Отмена клиента должна завершать upstream HTTP и освобождать parser/reader.

Reference отдаёт message_start сразу после успешных upstream headers, с нулевым input usage. Финальные input/cache usage приходят в message_delta. Проверить, что конкретный Claude Code учитывает их, иначе менять стратегию начала/учёта.

JSON response строится тем же encoder через накопление событий. Но при непарсящихся tool arguments возвращается `input:{_raw:...}`, а JSON array/null также не запрещены. Для Go финальные tool arguments должны быть объектом, иначе ошибка; JSON и streaming должны согласованно сообщать повреждение до выполнения tool.

Официальный [Anthropic streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming) подтверждает последовательность lifecycle, cumulative usage и signature перед закрытием thinking block.

## Reasoning replay

Reference запрашивает `include:["reasoning.encrypted_content"]`. Полный reasoning item кодируется как:

```text
ccp:openai:v1: + base64url(JSON({version:1, provider:"openai", model, item}))
```

`item` содержит type=reasoning, ID, encrypted_content, summary и при наличии reasoning_text content. Envelope ограничен 4 MiB; ID — 512 символов. На следующем ходе thinking.signature декодируется, проверяется provider/version/model, item вставляется перед следующим call в соответствии с историей. Это base64 envelope, не криптографическая signature моста; содержимое reasoning остаётся зашифрованным провайдером.

При несовпадении model, неизвестном prefix или повреждённом envelope reference молча не делает replay. Если encrypted state отсутствует, encoder выдаёт synthetic signature, которая не будет принята OpenAI decoder. Она служит только форме thinking block, не доказывает сохранение reasoning. Decoder не связывает state с endpoint/account; optional model без значения допускается.

Для Go: versioned envelope с endpoint/deployment/configured credential scope, без включения key; size checks; диагностика пропущенного replay; никогда не выдавать synthetic signature за provider state. При смене модели/аккаунта старый state не переносить. Проверить реальный Claude Code: возвращает ли он signature неизменной, как compaction и переключение effort/model меняют историю. Это обязательный live тест, offline fixtures его не заменяют.

Сохранение reasoning items при ручном ведении tool history требуется по [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning). Наличие encrypted_content и принимаемые include/summary параметры для конкретного Azure API version нужно проверить отдельно.

## Usage и оценка контекста

Reference возвращает OpenAI total input_tokens как Anthropic input_tokens и отдельно добавляет cached_tokens в cache_read_input_tokens. Для input=100/cached=60 получается 100+60=160 при Anthropic подсчёте. Это двойной учёт cache. Правило Anthropic: total input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens; подтверждено [prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Предложение для Go: input_tokens=max(0,Azure.input_tokens-cached_tokens), cache_read_input_tokens=cached_tokens, cache_creation_input_tokens=0, если Azure не даёт отдельный write count. Хранить настоящий Azure usage отдельно для диагностики, не применять Anthropic цены. Output_tokens остаётся inclusive total; reasoning_tokens не прибавлять повторно.

count_tokens в reference — weighted characters плюс фиксированные overhead и грубая оценка image patches. Он не гарантированно conservative: тест проверяет только рост оценки при добавлении content. Thinking.signature не входит в оценку thinking block. Go должен обозначать оценку и иметь настраиваемый reserve до context limit; настоящая tokenization/transformed request важнее suffix `[1m]`. Сам suffix лишь удаляется из model name, не увеличивает Azure контекст.

## Azure transport

Reference отправляет `POST baseUrl + "/responses"`, bearer key, application/json и accept SSE. Azure dated endpoint с query ломается: `.../openai?api-version=.../responses`. Полный URL с `/responses` также получит повторный suffix. Отдельных api-key headers и api-version settings нет.

Go принимает полный `AZURE_RESPONSES_URL` буквально, например:

```text
https://RESOURCE.openai.azure.com/openai/v1/responses
https://RESOURCE.openai.azure.com/openai/responses?api-version=2025-04-01-preview
```

Два варианта не смешивать и не перебирать после 404. Azure deployment передаётся как body.model. Header auth задаётся явно (`api-key` для статического Azure key; bearer для явно выбранного режима). Entra token refresh не включать в MVP без необходимости. [Azure v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) снимает обязательность dated api-version; [REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses) описывает оба header auth варианта.

Reference использует request-header timeout 120 s, idle timeout 300 s, max response 64 MiB, два retry. Retryable statuses: 408/409/425/429/5xx. После успешного response body retries прекращаются. Возможны повторные расходы при transport error с неопределённым результатом POST: для Go безопаснее retries по умолчанию выключить или ограничить явными HTTP отказами. Никогда не retry после отданных text/tool deltas. Retry-After сохранять, Azure apim-request-id логировать; API key и содержание conversation не логировать по умолчанию.

## Воспроизведённые дефекты

| Наблюдение | Доказательство | Что меняем |
| --- | --- | --- |
| Full suite не загружается | Четыре test-файла импортируют отсутствующий tokenhub.js | Не выбирать snapshot как готовый надёжный server |
| Cached input учитывается дважды | Fixture input=100/cached=60 → input=100/cache_read=60 | Разделить uncached и cached |
| CRLF на границе chunks меняет event | `event: demo\r` + `\ndata:...` → event=message вместо demo | Stateful line parser; pending CR до следующего byte |
| Native tool теряет семантику | web_search превращается в function без schema | Mapping или понятная ошибка |
| Некорректный tool JSON маскируется | `{broken` → `{_raw:"{broken"}` | Ошибка, не tool invocation |
| Полный upstream URL с query собирается неверно | String append ставит /responses внутри query value | Full URL без эвристик |
| Disabled thinking не выключает reasoning | Request.reasoning отсутствует, parser продолжает отдавать summaries | Явная политика reasoning effort и visible thinking |
| Unknown semantic output исчезает | web_search_call output → только usage/message_done | Явная capability/error политика |

CRLF дефект особенно неприятен для SSE без payload.type: named event теряется. При обычном Responses payload.type он может быть скрыт, но parser всё равно неверен. Это подтверждено synthetic probe, не live Azure инцидент.

## Предлагаемая структура Go

`config` хранит literal URL, auth mode, aliases, effort и limits. `anthropic` валидирует вход и кодирует Messages/SSE. `responses` переводит ordered input items и нормализует SSE. `reasoning` хранит versioned opaque envelope. `transport` делает один Azure POST с отменой, headers и timeout. `server` связывает их без stateful conversation cache.

Не переносим multi-provider router, OAuth login, TUI monitor, installer и provider model catalogs. Не нужны DB, model discovery и fallback между протоколами. Полезный принцип reference — одна нормализованная модель событий для streaming и JSON.

## Приёмка будущего моста

1. Literal URL/query и auth header проверяются локальным mock; 404 остаётся 404, Chat Completions не вызывается.
2. Tool cycle из fixture проходит с теми же call IDs и ordered reasoning/call/output, без двойных deltas из completed.
3. Несколько tools, позднее имя, fragmented JSON, UTF-8 и CRLF во всех split points проходят; final JSON object проверяется.
4. Terminal completed/incomplete/failed, EOF, upstream 429, JSON error, error после HTTP 200 дают согласованные результаты.
5. Model/endpoint switch, повреждённая/oversized signature и отсутствующий encrypted state диагностируются; sessions не смешиваются.
6. Usage fixture даёт total input=100, не 160; count_tokens и compaction reserve проверяются на настоящем контексте.
7. Disconnect и медленный consumer освобождают upstream без повторного исполнения tool.
8. Короткая настоящая сессия Claude Code → Azure: Read, Edit, Bash/test, повторный ход с reasoning signature, затем compaction. Сохранить обезличенные реальные wire fixtures.

Текущий результат достаточен для проектирования translator и mock tests. До live wire capture нельзя утверждать полную совместимость с современными Claude tool search, task budgets, inline instructions, context edits или provider-specific reasoning.
