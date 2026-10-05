# azupic

[English](README.md) · [Русский](README.RU.md) · [Українська](README.UK.md) · [Slovenčina](README.SK.md) · [Dansk](README.DA.md) · [Беларуская](README.BE.md)

**azupic** er en lille bro i Go mellem Anthropic Messages API, som Claude Code bruger, og Azure OpenAI Responses. Én binær fil, Gos standardbibliotek og et eksplicit endpoint og deployment. Version 0.1 er testet med lokale mock-tests og en kort rigtig samtale i Claude Code gennem Azure Responses, inklusive thinking og efterfølgende ture. Lokale værktøjer, interaktive ændringer af effort og compaction kræver yderligere afprøvning med rigtige forespørgsler.

## Downloads og udgivelser

Færdige binære filer til Linux, macOS og Windows, hver til amd64 og arm64, findes under [GitHub Releases](https://github.com/oisee/azupic/releases). Hent et arkiv og `checksums.txt`. Arkiverne indeholder programmet, licensen og alle sprogversioner af README. Filerne til macOS og Windows er ikke signerede.

Byg alle seks lokalt med `python3 scripts/build-release.py v0.1.0`; resultatet ligger i `dist/`. CI bygger de samme arkiver ved push og pull request. Et push af et versionstag kører tests, bygger alle platforme, kontrollerer checksums og uploader filerne til en kladde. Udgivelsen offentliggøres først, når alle uploads er gennemført. Workflowet kan også startes manuelt for et eksisterende tag.

## Byg og start

Kræver Go 1.24 eller nyere.

```sh
go build -buildvcs=false -o bin/azupic ./cmd/azupic
export AZURE_RESPONSES_URL='https://RESOURCE.openai.azure.com/openai/v1/responses'
export AZURE_DEPLOYMENT='YOUR_DEPLOYMENT'
# Angiv AZURE_OPENAI_API_KEY i miljøet.
export REASONING_EFFORT=high
./bin/azupic
```

En fuld URL med API-version understøttes også: `https://RESOURCE.openai.azure.com/openai/responses?api-version=YOUR_VERSION`. Broen bruger URL'en uændret og sender deployment i feltet `model`. Den prøver ikke andre URL'er eller protokoller efter en 404. HTTP upstream er kun tilladt på loopback til lokale mock-servere.

I en anden terminal:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
ANTHROPIC_AUTH_TOKEN=local-azupic \
ENABLE_TOOL_SEARCH=false \
claude --model azupic
```

Som standard mappes alle indgående modelnavne til `AZURE_DEPLOYMENT`. Du behøver ikke give Azure-modellen et Claude-modelnavn eller tilføje `[1m]`. Hvis Claude Code bruger en anden udbyder eller godkendelsesmetode, skal du bruge en separat klientprofil med eksplicit godkendelse til det lokale endpoint. Angiv ikke både `ANTHROPIC_API_KEY` og `ANTHROPIC_AUTH_TOKEN`.

## Konfiguration

Når `AZURE_RESPONSES_URL` er angivet, kan du starte både broen og Claude Code med deployment `gpt-6.1-sol`:

```sh
bash scripts/run-claude.sh
```

Scriptet angiver miljøvariabler for sine egne processer, bruger den eksisterende `AZURE_OPENAI_API_KEY`, starter broen på `127.0.0.1:8080` og stopper den, når Claude afsluttes. Loggen ligger i `.local/azupic.log`. Vælg et andet deployment med `AZUPIC_DEPLOYMENT`. Argumenter sendes videre til Claude, for eksempel `bash scripts/run-claude.sh -p 'Svar med ét ord: OK'`. Kræver `curl` og tilladelse til at åbne lokale TCP-sockets.

| Variabel | Formål eller standardværdi |
| --- | --- |
| `AZURE_RESPONSES_URL` | Påkrævet fuld Responses-URL |
| `AZURE_DEPLOYMENT` | Påkrævet Azure-deploymentnavn |
| `AZURE_OPENAI_DEPLOYMENT` | Alternativ til `AZURE_DEPLOYMENT`; hvis begge er angivet, skal værdierne være ens |
| `AZURE_OPENAI_API_KEY` | Påkrævede legitimationsoplysninger til upstream |
| `AZURE_AUTH_MODE` | Som standard `api-key`; `bearer` til eksplicit angivne bearer-legitimationsoplysninger, uden fornyelse af Entra-token |
| `LISTEN_ADDR` | `127.0.0.1:8080` |
| `AZUPIC_TOKEN` | Separat klienttoken; påkrævet uden for loopback |
| `AZUPIC_MODEL_ALIASES` | JSON map, f.eks. `{"azupic":"deployment-a","fast":"deployment-b"}` |
| `REASONING_EFFORT` | Valgfrit: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; understøttelsen afhænger af deployment |
| `AZUPIC_BODY_LIMIT` | Grænse for indgående body i bytes; som standard 20 MiB |
| `AZUPIC_RESPONSE_LIMIT` | Grænse for upstream SSE i bytes; som standard 64 MiB |
| `AZUPIC_TIMEOUT` | Samlet timeout for generering; som standard `10m` |
| `AZUPIC_IDLE_TIMEOUT` | Timeout ved inaktivitet under upstream-læsning og downstream-skrivning; som standard `5m` |

Klienttokens accepteres via `x-api-key` eller `Authorization: Bearer`. Brug et separat token, ikke Azure-nøglen. Sørg for TLS foran broen, hvis den er offentligt tilgængelig.

## Protokolunderstøttelse

`POST /v1/messages` returnerer Anthropic JSON eller SSE afhængigt af feltet `stream`. Query `?beta=true` understøttes. Upstream bruger altid Responses SSE. System/developer-tekstbeskeder inde i historikken bevarer rolle og placering. Tekst, afvisninger fra modellen, almindelige function tools, værktøjsresultater, brugerbilleder og billeder i værktøjsresultater bevarer rækkefølgen. Indlejrede værktøjsskemaer bevares. Claude Code udfører Read, Edit, Bash og MCP tools.

Encrypted reasoning overføres i `thinking.signature` via en `azupic:responses:v1:`-envelope knyttet til den fulde URL, deployment og legitimationsoplysninger. Ændringer af disse indstillinger kræver en ny session. Envelopen indeholder krypteret udbydertilstand; den er ikke en kryptografisk signatur. Manglende encrypted state er en fejl. Almindelige efterfølgende ture fungerer i en rigtig session; replay gennem en fuld værktøjscyklus og compaction skal stadig afprøves live.

`max_tokens` mappes til `max_output_tokens`, som inkluderer reasoning. Prioriteten for effort er `output_config.effort`, derefter `thinking.effort`, derefter `REASONING_EFFORT`. `thinking.budget_tokens` accepteres som et klienthint uden at omsætte et separat budget. `thinking.type=disabled` garanterer ikke, at Azure reasoning slås fra: det valgte effort gælder, og returnerede summaries bevares til replay.

`output_config.format` med et JSON schema mappes til Responses structured output. Anthropic cache breakpoints og metadata sendes ikke upstream. Cachelagrede inputtokens tælles separat: Azure input=100/cached=60 bliver Anthropic input=40/cache_read=60. Reasoning output lægges ikke til to gange.

Native hosted tools, deferred tool search, `tool_reference`, documents, andre roller end user/assistant/system/developer og ukendte content blocks returnerer HTTP 400. `stop_sequences`, `top_p` og `top_k` understøttes ikke; tomme `stop_sequences` og standardværdien `temperature=1` accepteres. `context_management.edits` accepterer `clear_thinking_20251015` og `clear_tool_uses_20250919`, men bevarer hele historikken, logger at rydning ikke blev udført og angiver aldrig, at edits blev anvendt. Det bevarer Responses reasoning replay; Anthropic-rydning på serveren er ikke implementeret. Andre strategier, inklusive server-side compaction, afvises. Ukendt semantisk Azure-output er en fejl. Dette er indledende kompatibilitet, ikke en fuld implementering af Anthropic API.

`POST /v1/messages/count_tokens` estimerer tokens ud fra den transformerede forespørgsel, inklusive skemaer og signatures, med svarheaderen `x-azupic-token-count: estimate`. Det er ikke en Azure-tokenizer eller en garanti for, at forespørgslen passer i kontekstvinduet; billedestimater er også upræcise. `GET /healthz` kontrollerer kun processen.

Azure HTTP-fejl bevarer status og `Retry-After` uden at videresende upstream error body. Fejl efter SSE-start sendes som en `error`-hændelse uden en vellykket `message_stop`. EOF før en terminal event er en fejl. POST-forespørgsler gentages aldrig automatisk. Annullering fra klienten lukker upstream-forespørgsler. Logs indeholder endpoint med skjulte query-parametre, deployment, status og `apim-request-id`, uden nøgler eller samtalehistorik.

## Skift reasoning effort

For at starte fra en vilkårlig mappe skal du tilføje `source /path/to/azupic/scripts/bash-integration.sh` til `~/.bashrc`. Genindlæs shellen for at bruge `claude-az`, for eksempel `claude-az --effort high`. Kommandoen starter broen og Claude i den aktuelle arbejdsmappe og rydder nedarvede udbyderindstillinger i en subshell, mens den overordnede terminals miljø bevares.

Scriptet aktiverer `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for modellen `azupic` og fjerner fast `CLAUDE_CODE_EFFORT_LEVEL`, så det ikke tilsidesætter interaktive ændringer. Start med `bash scripts/run-claude.sh --effort high`. Under sessionen kan du bruge `/effort low`, `/effort medium`, `/effort high` eller `/effort xhigh`. Den nye værdi gælder for næste forespørgsel uden genstart af azupic. Dit Azure-deployment skal understøtte niveauet.

Claude `max` mappes til Azure `xhigh`; andre niveauer sendes uændret videre. `/effort auto` fjerner klientens valg: broen bruger `REASONING_EFFORT` fra opstarten, hvis det er angivet, ellers Azure-standardværdien. `.local/azupic.log` registrerer `generation request` med `reasoning_effort`. Ændringer af effort ændrer ikke reasoning-signaturens scope. Interaktiv overførsel af effort fra den rigtige Claude-klient skal stadig bekræftes i disse logs.

## Kontroller

```sh
go test -race ./...
go vet ./...
```

Tests bruger rigtig HTTP/1.1 over `net.Pipe` uden TCP-porte eller Azure. De dækker tool/reasoning replay, call IDs, historikkens rækkefølge, parallelle værktøjer, forsinkede navne, ugyldig JSON, uoverensstemmelser mellem streamed/final arguments, fjernelse af dubleret sluttekst, usage, max_tokens, ikke-understøttede capabilities, CRLF/UTF-8 ved alle opdelingspunkter, literal URL og godkendelse, HTTP 404/429, EOF, idle timeout og klientannullering.

Forskningskilder: [kontrakten på russisk](docs/anthropic-azure-responses-contract.md) og MIT [dywongcloud/claude-code-proxy snapshot](reference/SOURCE.json). Go-implementeringen er skrevet separat; reference-snapshot er ikke rettet. Kravet om reasoning replay ved værktøjer beskrives i [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
