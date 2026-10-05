# azupic

[English](README.md) · [Русский](README.RU.md) · [Українська](README.UK.md) · [Slovenčina](README.SK.md) · [Dansk](README.DA.md) · [Беларуская](README.BE.md)

**azupic** — невялікі мост на Go паміж Anthropic Messages API, які выкарыстоўвае Claude Code, і Azure OpenAI Responses. Адзін выканальны файл, стандартная бібліятэка Go, яўна зададзеныя endpoint і deployment. Версія 0.1 праверана лакальнымі mock-тэстамі і кароткай рэальнай размовай Claude Code праз Azure Responses, з thinking і наступнымі хадамі. Выкананне лакальных інструментаў, інтэрактыўная змена effort і compaction патрабуюць далейшай праверкі на рэальных запытах.

## Спампоўванне і рэлізы

Гатовыя выканальныя файлы для Linux, macOS і Windows, для кожнай сістэмы — amd64 і arm64, даступныя ў [GitHub Releases](https://github.com/oisee/azupic/releases). Спампуйце архіў і `checksums.txt`. Архіў змяшчае праграму, ліцэнзію і ўсе моўныя версіі README. Файлы для macOS і Windows не падпісаныя.

Зборка ўсіх шасці варыянтаў: `python3 scripts/build-release.py v0.1.0`; вынік захоўваецца ў `dist/`. CI стварае такія ж архівы для push і pull request. Push тэга версіі запускае тэсты, зборку і праверку кантрольных сум, загружае файлы ў чарнавік рэлізу і публікуе яго пасля паспяховай загрузкі ўсіх файлаў. Workflow таксама можна запусціць уручную для наяўнага тэга.

## Зборка і запуск

Патрэбны Go 1.24 або навейшы.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# Задайце AZURE_OPENAI_API_KEY у асяроддзі.
export REASONING_EFFORT=high
./bin/azupic
```

Падтрымліваецца таксама поўны URL з версіяй API: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. Мост выкарыстоўвае URL без змен і перадае deployment у полі `model`. Пасля 404 ён не перабірае іншыя URL або пратаколы. HTTP upstream дазволены толькі на loopback для лакальных mock-сервераў.

У іншым тэрмінале:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

Па змаўчанні любая ўваходная назва мадэлі адлюстроўваецца на `AZURE_DEPLOYMENT`. Не трэба называць мадэль Azure у гонар Claude або дадаваць `[1m]`. Калі Claude Code наладжаны на іншага правайдара ці іншы спосаб аўтэнтыфікацыі, выкарыстоўвайце асобны профіль кліента з яўна зададзенай аўтэнтыфікацыяй для лакальнага endpoint. Не задавайце адначасова `ANTHROPIC_API_KEY` і `ANTHROPIC_AUTH_TOKEN`.

## Канфігурацыя

Пасля наладжвання `AZURE_RESPONSES_URL` можна запусціць мост і Claude Code з deployment `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

Скрыпт задае зменныя толькі для ўласных працэсаў, выкарыстоўвае наяўны `AZURE_OPENAI_API_KEY`, запускае мост на `127.0.0.1:8080` і спыняе яго пасля выхаду з Claude. Лог: `.local/azupic.log`. Іншы deployment задаецца праз `AZUPIC_DEPLOYMENT`. Аргументы перадаюцца Claude, напрыклад `bash scripts/run-claude.sh -p 'Адкажы адным словам: OK'`. Патрэбныя `curl` і дазвол асяроддзя на лакальныя TCP-сокеты.

| Зменная | Прызначэнне або значэнне па змаўчанні |
| --- | --- |
| `AZURE_RESPONSES_URL` | Абавязковы поўны URL Responses |
| `AZURE_DEPLOYMENT` | Абавязковая назва deployment Azure |
| `AZURE_OPENAI_DEPLOYMENT` | Альтэрнатыва `AZURE_DEPLOYMENT`; калі зададзены абедзве, значэнні павінны супадаць |
| `AZURE_OPENAI_API_KEY` | Абавязковыя ўліковыя даныя upstream |
| `AZURE_AUTH_MODE` | Па змаўчанні `api-key`; `bearer` для яўна зададзеных bearer credential, без абнаўлення токена Entra |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Асобны токен кліента; абавязковы па-за loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, напрыклад `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Неабавязкова: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; падтрымка залежыць ад deployment |
| `AZUPIC_BODY_LIMIT` | Ліміт уваходнага цела ў байтах; па змаўчанні 20 MiB |
| `AZUPIC_RESPONSE_LIMIT` | Ліміт upstream SSE ў байтах; па змаўчанні 64 MiB |
| `AZUPIC_TIMEOUT` | Агульны таймаўт генерацыі; па змаўчанні `10m` |
| `AZUPIC_IDLE_TIMEOUT` | Таймаўт чакання чытання upstream і запісу downstream; па змаўчанні `5m` |

Токен кліента прымаецца праз `x-api-key` або `Authorization: Bearer`. Выкарыстоўвайце асобны токен, а не ключ Azure. Для публічнага доступу забяспечце TLS перад мостам.

## Падтрымка пратаколу

`POST /v1/messages` вяртае Anthropic JSON або SSE паводле поля `stream`. Падтрымліваецца query `?beta=true`. Upstream заўсёды выкарыстоўвае Responses SSE. Тэкставыя паведамленні system/developer у гісторыі захоўваюць ролю і пазіцыю. Тэкст, адмовы мадэлі, звычайныя function tools, вынікі інструментаў, выявы карыстальніка і выявы ў выніках інструментаў перадаюцца з захаваннем парадку. Укладзеныя схемы інструментаў захоўваюцца. Read, Edit, Bash і MCP tools выконвае Claude Code.

Encrypted reasoning пераносіцца праз `thinking.signature` у кантэйнеры `azupic:responses:v1:`, прывязаным да поўнага URL, deployment і ўліковых даных. Змена гэтых налад патрабуе новай сесіі. Кантэйнер змяшчае зашыфраваны стан правайдара; гэта не крыптаграфічны подпіс. Адсутнасць encrypted state з'яўляецца памылкай. Звычайныя наступныя хады працуюць у рэальнай сесіі; replay у поўным цыкле інструментаў і compaction яшчэ патрабуюць live-праверкі.

`max_tokens` адлюстроўваецца на `max_output_tokens`, які ўключае reasoning. Прыярытэт effort: `output_config.effort`, потым `thinking.effort`, потым `REASONING_EFFORT`. `thinking.budget_tokens` прымаецца як падказка кліента без пераўтварэння ў асобны бюджэт. `thinking.type=disabled` не гарантуе выключэння reasoning у Azure: дзейнічае выбраны effort, а атрыманыя summary захоўваюцца для replay.

`output_config.format` з JSON schema пераўтвараецца ў Responses structured output. Anthropic cache breakpoints і metadata не перадаюцца upstream. Кэшаваныя ўваходныя токены ўлічваюцца асобна: Azure input=100/cached=60 → Anthropic input=40/cache_read=60. Reasoning output не дадаецца двойчы.

Native hosted tools, deferred tool search, `tool_reference`, documents, ролі акрамя user/assistant/system/developer і невядомыя content blocks вяртаюць HTTP 400. `stop_sequences`, `top_p` і `top_k` не падтрымліваюцца; пустыя `stop_sequences` і стандартнае `temperature=1` дазволеныя. `context_management.edits` прымае `clear_thinking_20251015` і `clear_tool_uses_20250919`, але захоўвае поўную гісторыю, запісвае ў лог адсутнасць ачысткі і не заяўляе пра ўжытыя edits. Гэта захоўвае Responses reasoning replay; серверная ачыстка Anthropic не рэалізаваная. Іншыя стратэгіі, у тым ліку серверны compaction, адхіляюцца. Невядомы семантычны output Azure з'яўляецца памылкай. Гэта пачатковая сумяшчальнасць, а не поўная рэалізацыя Anthropic API.

`POST /v1/messages/count_tokens` прыблізна ацэньвае токены паводле пераўтворанага запыту, уключаючы схемы і signatures, і вяртае загаловак `x-azupic-token-count: estimate`. Гэта не tokenizer Azure і не гарантыя, што запыт змесціцца ў кантэкстнае акно; ацэнка выяў таксама недакладная. `GET /healthz` правярае толькі працэс.

HTTP-памылкі Azure захоўваюць status і `Retry-After` без перадачы upstream error body. Памылкі пасля пачатку SSE прыходзяць як падзея `error` без паспяховага `message_stop`. EOF да terminal event з'яўляецца памылкай. POST-запыты ніколі не паўтараюцца аўтаматычна. Скасаванне кліентам закрывае upstream. Логі змяшчаюць endpoint са схаванымі query-параметрамі, deployment, status і `apim-request-id`, без ключоў і гісторыі размовы.

## Змена reasoning effort

Для запуску з любой папкі дадайце `source /path/to/azupic/scripts/bash-integration.sh` у `~/.bashrc`. Перазагрузіце shell, каб выкарыстоўваць `claude-az`, напрыклад `claude-az --effort high`. Каманда запускае мост і Claude ў бягучай рабочай папцы і ачышчае ўспадкаваныя налады правайдара ў subshell, захоўваючы асяроддзе бацькоўскага тэрмінала.

Скрыпт уключае `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` для мадэлі `azupic` і прыбірае фіксаваны `CLAUDE_CODE_EFFORT_LEVEL`, каб ён не перакрываў інтэрактыўныя змены. Пачатковы ўзровень: `bash scripts/run-claude.sh --effort high`. Падчас сесіі выкарыстоўвайце `/effort low`, `/effort medium`, `/effort high` або `/effort xhigh`. Новае значэнне ўжываецца да наступнага запыту без перазапуску azupic. Deployment Azure павінен падтрымліваць выбраны ўзровень.

Claude `max` пераўтвараецца ў Azure `xhigh`; іншыя ўзроўні перадаюцца без змен. `/effort auto` скідае выбар кліента: мост выкарыстоўвае зададзены пры запуску `REASONING_EFFORT` або default Azure. `.local/azupic.log` змяшчае `generation request` з `reasoning_effort`. Змена effort не змяняе вобласць дзеяння reasoning signature. Перадачу інтэрактыўнага effort рэальным Claude яшчэ трэба пацвердзіць гэтымі логамі.

## Праверкі

```sh
go test -race ./...
go vet ./...
```

Тэсты выкарыстоўваюць сапраўдны HTTP/1.1 праз `net.Pipe`, без TCP-партоў або Azure. Правяраюцца tool/reasoning replay, call IDs, парадак гісторыі, паралельныя інструменты, позняя назва, пашкоджаны JSON, неадпаведнасць streamed/final arguments, адсутнасць дублявання фінальнага тэксту, usage, max_tokens, непадтрыманыя capabilities, CRLF/UTF-8 на ўсіх межах разбіцця, literal URL і аўтэнтыфікацыя, HTTP 404/429, EOF, idle timeout і скасаванне кліентам.

Крыніцы даследавання: [кантракт па-руску](docs/anthropic-azure-responses-contract.md) і MIT [snapshot dywongcloud/claude-code-proxy](reference/SOURCE.json). Go-код напісаны асобна; reference пакінуты без выпраўленняў. Патрабаванне reasoning replay для інструментаў апісана ў [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
