# azupic

[English](README.md) · [Русский](README.RU.md) · [Українська](README.UK.md) · [Slovenčina](README.SK.md) · [Dansk](README.DA.md) · [Беларуская](README.BE.md)

**azupic** je malý most v Go medzi Anthropic Messages API, ktoré používa Claude Code, a Azure OpenAI Responses. Jeden spustiteľný súbor, štandardná knižnica Go, explicitný endpoint a deployment. Verzia 0.1 bola overená lokálnymi mock testami a krátkou reálnou konverzáciou Claude Code cez Azure Responses vrátane thinking a ďalších ťahov. Spúšťanie lokálnych nástrojov, interaktívne zmeny effort a compaction ešte vyžadujú ďalšie overenie na reálnych požiadavkách.

## Stiahnutie a vydania

Hotové binárne súbory pre Linux, macOS a Windows, pre každý systém na amd64 a arm64, sú dostupné v [GitHub Releases](https://github.com/oisee/azupic/releases). Stiahnite archív a `checksums.txt`. Archív obsahuje program, licenciu a všetky jazykové verzie README. Binárne súbory pre macOS a Windows nie sú podpísané.

Všetkých šesť variantov zostavíte príkazom `python3 scripts/build-release.py v0.1.0`; výstup je v `dist/`. CI vytvára rovnaké archívy pri push a pull request. Push značky verzie spustí testy, zostavenie a kontrolu súčtov, nahrá súbory do konceptu vydania a zverejní ho až po úspešnom nahratí všetkých súborov. Workflow možno spustiť aj ručne pre existujúcu značku.

## Zostavenie a spustenie

Vyžaduje Go 1.24 alebo novší.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# Nastavte AZURE_OPENAI_API_KEY v prostredí.
export REASONING_EFFORT=high
./bin/azupic
```

Podporovaná je aj úplná URL s verziou API: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. Most používa URL bez úprav a deployment posiela v poli `model`. Po chybe 404 neskúša alternatívne URL ani protokoly. HTTP upstream je povolený iba na loopback pre lokálne mock servery.

V inom termináli:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

Predvolene sa každý vstupný názov modelu mapuje na `AZURE_DEPLOYMENT`. Model Azure nemusíte pomenovať podľa modelu Claude ani pridávať `[1m]`. Ak Claude Code používa iného poskytovateľa alebo spôsob autentifikácie, použite samostatný profil klienta s explicitnou autentifikáciou pre lokálny endpoint. Nenastavujte súčasne `ANTHROPIC_API_KEY` a `ANTHROPIC_AUTH_TOKEN`.

## Konfigurácia

Po nastavení `AZURE_RESPONSES_URL` spustíte most aj Claude Code s deploymentom `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

Skript nastavuje premenné iba pre vlastné procesy, používa existujúci `AZURE_OPENAI_API_KEY`, spustí most na `127.0.0.1:8080` a zastaví ho po ukončení Claude. Log je v `.local/azupic.log`. Iný deployment vyberiete cez `AZUPIC_DEPLOYMENT`. Argumenty sa odovzdávajú Claude, napríklad `bash scripts/run-claude.sh -p 'Odpovedz jedným slovom: OK'`. Vyžaduje `curl` a povolenie prostredia na otvorenie lokálnych TCP socketov.

| Premenná | Účel alebo predvolená hodnota |
| --- | --- |
| `AZURE_RESPONSES_URL` | Povinná úplná URL Responses |
| `AZURE_DEPLOYMENT` | Povinný názov deploymentu Azure |
| `AZURE_OPENAI_DEPLOYMENT` | Alternatíva k `AZURE_DEPLOYMENT`; ak sú nastavené obe, hodnoty sa musia zhodovať |
| `AZURE_OPENAI_API_KEY` | Povinné prihlasovacie údaje upstream |
| `AZURE_AUTH_MODE` | Predvolene `api-key`; `bearer` pre explicitne zadaný bearer credential, bez obnovovania tokenu Entra |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Samostatný token klienta; povinný mimo loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, napríklad `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Voliteľne: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; podpora závisí od deploymentu |
| `AZUPIC_BODY_LIMIT` | Limit vstupného tela v bajtoch; predvolene 20 MiB |
| `AZUPIC_RESPONSE_LIMIT` | Limit upstream SSE v bajtoch; predvolene 64 MiB |
| `AZUPIC_TIMEOUT` | Celkový časový limit generovania; predvolene `10m` |
| `AZUPIC_IDLE_TIMEOUT` | Limit nečinnosti pri čítaní upstream a zápise downstream; predvolene `5m` |

Token klienta sa prijíma cez `x-api-key` alebo `Authorization: Bearer`. Použite samostatný token, nie kľúč Azure. Pri verejnom prístupe zabezpečte TLS pred mostom.

## Podpora protokolu

`POST /v1/messages` vracia Anthropic JSON alebo SSE podľa poľa `stream`. Query `?beta=true` je podporované. Upstream vždy používa Responses SSE. Textové správy system/developer v histórii zachovávajú rolu aj pozíciu. Text, odmietnutia modelu, bežné function tools, výsledky nástrojov, obrázky používateľa a obrázky vo výsledkoch nástrojov zachovávajú poradie histórie. Vnorené schémy nástrojov sa zachovávajú. Read, Edit, Bash a MCP tools vykonáva Claude Code.

Encrypted reasoning sa prenáša v `thinking.signature` cez obálku `azupic:responses:v1:`, viazanú na úplnú URL, deployment a prihlasovacie údaje. Zmena týchto nastavení vyžaduje novú reláciu. Obálka obsahuje zašifrovaný stav poskytovateľa; nejde o kryptografický podpis. Chýbajúci encrypted state je chyba. Bežné ďalšie ťahy fungujú v reálnej relácii; replay v úplnom cykle nástrojov a compaction ešte vyžadujú live overenie.

`max_tokens` sa mapuje na `max_output_tokens`, ktorý zahŕňa reasoning. Priorita effort je `output_config.effort`, potom `thinking.effort`, potom `REASONING_EFFORT`. `thinking.budget_tokens` sa prijíma ako pokyn klienta bez prekladu samostatného rozpočtu. `thinking.type=disabled` nezaručuje vypnutie reasoning v Azure: platí zvolený effort a vrátené summary sa uchovávajú pre replay.

`output_config.format` s JSON schema sa mapuje na Responses structured output. Anthropic cache breakpoints a metadata sa neposielajú upstream. Vstupné tokeny z cache sa účtujú samostatne: Azure input=100/cached=60 → Anthropic input=40/cache_read=60. Reasoning output sa nepripočítava dvakrát.

Native hosted tools, deferred tool search, `tool_reference`, documents, roly iné než user/assistant/system/developer a neznáme content blocks vracajú HTTP 400. `stop_sequences`, `top_p` a `top_k` nie sú podporované; prázdne `stop_sequences` a predvolené `temperature=1` sú povolené. `context_management.edits` prijíma `clear_thinking_20251015` a `clear_tool_uses_20250919`, ale zachováva celú históriu, zaznamenáva, že čistenie nebolo vykonané, a netvrdí, že edits boli aplikované. Tak sa zachová Responses reasoning replay; serverové čistenie Anthropic nie je implementované. Iné stratégie vrátane serverového compaction sa odmietajú. Neznámy sémantický output Azure je chyba. Ide o počiatočnú kompatibilitu, nie úplnú implementáciu Anthropic API.

`POST /v1/messages/count_tokens` odhaduje tokeny z transformovanej požiadavky vrátane schém a signatures, s hlavičkou odpovede `x-azupic-token-count: estimate`. Nie je to tokenizer Azure ani záruka, že sa požiadavka zmestí do kontextového okna; odhady obrázkov sú tiež nepresné. `GET /healthz` kontroluje iba proces.

HTTP chyby Azure zachovávajú status a `Retry-After` bez odoslania upstream error body. Chyby po začatí SSE vytvoria udalosť `error` bez úspešného `message_stop`. EOF pred terminal event je chyba. POST požiadavky sa nikdy automaticky neopakujú. Zrušenie klientom zatvára upstream požiadavky. Logy obsahujú endpoint so skrytými query parametrami, deployment, status a `apim-request-id`, bez kľúčov a histórie konverzácie.

## Zmena reasoning effort

Pre spustenie z ľubovoľného priečinka pridajte `source /path/to/azupic/scripts/bash-integration.sh` do `~/.bashrc`. Znovu načítajte shell a použite `claude-az`, napríklad `claude-az --effort high`. Príkaz spustí most a Claude v aktuálnom pracovnom priečinku a vyčistí zdedené nastavenia poskytovateľa v subshell, pričom zachová prostredie nadradeného terminálu.

Skript zapína `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` pre model `azupic` a odstraňuje pevný `CLAUDE_CODE_EFFORT_LEVEL`, aby neprepisoval interaktívne zmeny. Začnite s `bash scripts/run-claude.sh --effort high`. Počas relácie používajte `/effort low`, `/effort medium`, `/effort high` alebo `/effort xhigh`. Nová hodnota sa použije pri ďalšej požiadavke bez reštartu azupic. Deployment Azure musí zvolenú úroveň podporovať.

Claude `max` sa mapuje na Azure `xhigh`; ostatné úrovne sa odovzdávajú bez zmeny. `/effort auto` zruší výber klienta: most použije `REASONING_EFFORT` nastavený pri spustení alebo default Azure. `.local/azupic.log` zaznamenáva `generation request` s `reasoning_effort`. Zmena effort nemení rozsah reasoning signature. Interaktívny prenos effort zo skutočného klienta Claude ešte treba potvrdiť v týchto logoch.

## Kontroly

```sh
go test -race ./...
go vet ./...
```

Testy používajú skutočné HTTP/1.1 cez `net.Pipe` bez TCP portov alebo Azure. Pokrývajú tool/reasoning replay, call IDs, poradie histórie, paralelné nástroje, oneskorené názvy, poškodený JSON, nezhodu streamed/final arguments, odstránenie duplicít finálneho textu, usage, max_tokens, nepodporované capabilities, CRLF/UTF-8 na každej hranici rozdelenia, literal URL a autentifikáciu, HTTP 404/429, EOF, idle timeout a zrušenie klientom.

Zdroje výskumu: [kontrakt v ruštine](docs/anthropic-azure-responses-contract.md) a MIT [snapshot dywongcloud/claude-code-proxy](reference/SOURCE.json). Implementácia Go bola napísaná samostatne; reference zostal bez opráv. Požiadavku reasoning replay pri nástrojoch opisuje [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
