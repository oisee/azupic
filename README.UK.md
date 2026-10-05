# azupic

[English](README.md) · [Русский](README.RU.md) · [Українська](README.UK.md) · [Slovenčina](README.SK.md) · [Dansk](README.DA.md) · [Беларуская](README.BE.md)

**azupic** — невеликий міст на Go між Anthropic Messages API, який використовує Claude Code, та Azure OpenAI Responses. Один виконуваний файл, стандартна бібліотека Go, явно задані endpoint і deployment. Версію 0.1 перевірено локальними mock-тестами та короткою реальною розмовою Claude Code через Azure Responses, з thinking і наступними ходами. Виконання локальних інструментів, інтерактивна зміна effort і compaction потребують подальшої перевірки на реальних запитах.

## Завантаження та релізи

Готові виконувані файли для Linux, macOS і Windows, для кожної системи — amd64 та arm64, доступні в [GitHub Releases](https://github.com/oisee/azupic/releases). Завантажте архів і `checksums.txt`. Архів містить програму, ліцензію та всі мовні версії README. Файли для macOS і Windows не підписані.

Збірка всіх шести варіантів: `python3 scripts/build-release.py v0.1.0`; результат зберігається в `dist/`. CI створює такі самі архіви для push і pull request. Push тега версії запускає тести, збірку та перевірку контрольних сум, завантажує файли до чернетки релізу й публікує його після успішного завантаження всіх файлів. Workflow також можна запустити вручну для наявного тега.

## Збірка та запуск

Потрібен Go 1.24 або новіший.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# Задайте AZURE_OPENAI_API_KEY у середовищі.
export REASONING_EFFORT=high
./bin/azupic
```

Підтримується також повний URL із версією API: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. Міст використовує URL без змін і передає deployment у полі `model`. Після 404 він не перебирає інші URL або протоколи. HTTP upstream дозволений лише на loopback для локальних mock-серверів.

В іншому терміналі:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

За замовчуванням будь-яка вхідна назва моделі відображається на `AZURE_DEPLOYMENT`. Не потрібно називати модель Azure на честь Claude або додавати `[1m]`. Якщо Claude Code налаштований на іншого провайдера чи інший спосіб автентифікації, використовуйте окремий профіль клієнта з явно заданою автентифікацією для локального endpoint. Не задавайте одночасно `ANTHROPIC_API_KEY` і `ANTHROPIC_AUTH_TOKEN`.

## Конфігурація

Після налаштування `AZURE_RESPONSES_URL` можна запустити міст і Claude Code з deployment `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

Скрипт задає змінні лише для власних процесів, використовує наявний `AZURE_OPENAI_API_KEY`, запускає міст на `127.0.0.1:8080` і зупиняє його після виходу з Claude. Лог: `.local/azupic.log`. Інший deployment задається через `AZUPIC_DEPLOYMENT`. Аргументи передаються Claude, наприклад `bash scripts/run-claude.sh -p 'Відповідай одним словом: OK'`. Потрібні `curl` і дозвіл середовища на локальні TCP-сокети.

| Змінна | Призначення або значення за замовчуванням |
| --- | --- |
| `AZURE_RESPONSES_URL` | Обов’язковий повний URL Responses |
| `AZURE_DEPLOYMENT` | Обов’язкова назва deployment Azure |
| `AZURE_OPENAI_DEPLOYMENT` | Альтернатива `AZURE_DEPLOYMENT`; якщо задано обидві, значення мають збігатися |
| `AZURE_OPENAI_API_KEY` | Обов’язкові облікові дані upstream |
| `AZURE_AUTH_MODE` | Типово `api-key`; `bearer` для явно заданого bearer credential, без оновлення токена Entra |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Окремий токен клієнта; обов’язковий поза loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, наприклад `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Необов’язково: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; підтримка залежить від deployment |
| `AZUPIC_BODY_LIMIT` | Ліміт вхідного тіла в байтах; типово 20 MiB |
| `AZUPIC_RESPONSE_LIMIT` | Ліміт upstream SSE в байтах; типово 64 MiB |
| `AZUPIC_TIMEOUT` | Загальний таймаут генерації; типово `10m` |
| `AZUPIC_IDLE_TIMEOUT` | Таймаут очікування читання upstream і запису downstream; типово `5m` |

Токен клієнта приймається через `x-api-key` або `Authorization: Bearer`. Використовуйте окремий токен, а не ключ Azure. Для публічного доступу забезпечте TLS перед мостом.

## Підтримка протоколу

`POST /v1/messages` повертає Anthropic JSON або SSE відповідно до поля `stream`. Підтримується query `?beta=true`. Upstream завжди використовує Responses SSE. Текстові повідомлення system/developer усередині історії зберігають роль і позицію. Текст, відмови моделі, звичайні function tools, результати інструментів, зображення користувача та зображення в результатах інструментів передаються зі збереженням порядку. Вкладені схеми інструментів зберігаються. Read, Edit, Bash і MCP tools виконує Claude Code.

Encrypted reasoning переноситься через `thinking.signature` у контейнері `azupic:responses:v1:`, прив’язаному до повного URL, deployment та облікових даних. Зміна цих налаштувань потребує нової сесії. Контейнер містить зашифрований стан провайдера; це не криптографічний підпис. Відсутність encrypted state є помилкою. Звичайні наступні ходи працюють у реальній сесії; replay у повному циклі інструментів і compaction ще потребують live-перевірки.

`max_tokens` відображається на `max_output_tokens`, який включає reasoning. Пріоритет effort: `output_config.effort`, потім `thinking.effort`, потім `REASONING_EFFORT`. `thinking.budget_tokens` приймається як підказка клієнта без перетворення на окремий бюджет. `thinking.type=disabled` не гарантує вимкнення reasoning в Azure: діє вибраний effort, а отримані summary зберігаються для replay.

`output_config.format` із JSON schema перетворюється на Responses structured output. Anthropic cache breakpoints і metadata не передаються upstream. Кешовані вхідні токени обліковуються окремо: Azure input=100/cached=60 → Anthropic input=40/cache_read=60. Reasoning output не додається двічі.

Native hosted tools, deferred tool search, `tool_reference`, documents, ролі крім user/assistant/system/developer і невідомі content blocks повертають HTTP 400. `stop_sequences`, `top_p` і `top_k` не підтримуються; порожні `stop_sequences` і типове `temperature=1` дозволені. `context_management.edits` приймає `clear_thinking_20251015` і `clear_tool_uses_20250919`, але зберігає повну історію, записує в лог відсутність очищення й не заявляє про застосовані edits. Це зберігає Responses reasoning replay; серверне очищення Anthropic не реалізоване. Інші стратегії, зокрема серверний compaction, відхиляються. Невідомий семантичний output Azure є помилкою. Це початкова сумісність, а не повна реалізація Anthropic API.

`POST /v1/messages/count_tokens` приблизно оцінює токени за перетвореним запитом, включно зі схемами та signatures, і повертає заголовок `x-azupic-token-count: estimate`. Це не tokenizer Azure і не гарантія, що запит уміститься в контекстне вікно; оцінка зображень також неточна. `GET /healthz` перевіряє лише процес.

HTTP-помилки Azure зберігають status і `Retry-After` без передачі upstream error body. Помилки після початку SSE надходять як подія `error` без успішного `message_stop`. EOF до terminal event є помилкою. POST-запити ніколи не повторюються автоматично. Скасування клієнтом закриває upstream. Логи містять endpoint із прихованими query-параметрами, deployment, status і `apim-request-id`, без ключів та історії розмови.

## Зміна reasoning effort

Для запуску з будь-якої папки додайте `source /path/to/azupic/scripts/bash-integration.sh` у `~/.bashrc`. Перезавантажте shell, щоб використовувати `claude-az`, наприклад `claude-az --effort high`. Команда запускає міст і Claude в поточній робочій папці та очищає успадковані налаштування провайдера в subshell, зберігаючи середовище батьківського термінала.

Скрипт вмикає `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` для моделі `azupic` і прибирає фіксований `CLAUDE_CODE_EFFORT_LEVEL`, щоб він не перекривав інтерактивні зміни. Початковий рівень: `bash scripts/run-claude.sh --effort high`. Під час сесії використовуйте `/effort low`, `/effort medium`, `/effort high` або `/effort xhigh`. Нове значення застосовується до наступного запиту без перезапуску azupic. Deployment Azure має підтримувати вибраний рівень.

Claude `max` перетворюється на Azure `xhigh`; інші рівні передаються без змін. `/effort auto` скидає вибір клієнта: міст використовує заданий під час запуску `REASONING_EFFORT` або default Azure. `.local/azupic.log` містить `generation request` із `reasoning_effort`. Зміна effort не змінює область дії reasoning signature. Передачу інтерактивного effort реальним Claude ще потрібно підтвердити цими логами.

## Перевірки

```sh
go test -race ./...
go vet ./...
```

Тести використовують справжній HTTP/1.1 через `net.Pipe`, без TCP-портів або Azure. Перевіряються tool/reasoning replay, call IDs, порядок історії, паралельні інструменти, пізня назва, пошкоджений JSON, невідповідність streamed/final arguments, відсутність дублювання фінального тексту, usage, max_tokens, непідтримувані capabilities, CRLF/UTF-8 на всіх межах розбиття, literal URL та автентифікація, HTTP 404/429, EOF, idle timeout і скасування клієнтом.

Джерела дослідження: [контракт російською](docs/anthropic-azure-responses-contract.md) і MIT [snapshot dywongcloud/claude-code-proxy](reference/SOURCE.json). Go-код написано окремо; reference залишено без виправлень. Вимогу reasoning replay для інструментів описано в [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
