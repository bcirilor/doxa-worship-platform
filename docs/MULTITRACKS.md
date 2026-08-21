# Motor de multitracks — arquitetura

> O código deste módulo **não** faz parte do repositório público. Este documento
> descreve como ele funciona, os problemas que apareceram no caminho e as decisões
> que resolveram cada um.

O DoxaApp toca **multitracks** no navegador: uma música é um conjunto de faixas
separadas (click, guia, bateria, baixo, teclado, pad, guitarra, vocais) que tocam
em sincronia, com mixer por faixa, roteamento PA/fone, editor de arranjo, cifra
sincronizada e detecção automática de seções e acordes. Tudo client-side — sem
servidor de áudio, sem ML, sem processamento remoto.

## 1. Playback em chunks (o problema de RAM)

Uma música com 8 faixas de 5 minutos decodificada em `AudioBuffer` ocupa ~400MB de
RAM. Em celular isso mata a aba.

A solução foi **decodificar sob demanda em blocos de 3 segundos**, com 30ms de
crossfade entre blocos:

- um `Worker` decodifica cada chunk via **WebCodecs** (`AudioDecoder`);
- cada chunk vira um `AudioBufferSourceNode` agendado sequencialmente no
  `AudioContext`, no tempo exato;
- blocos já tocados são descartados.

Resultado: **~1MB de RAM por faixa** em vez de ~400MB no total. O custo é
agendamento preciso — qualquer atraso no decode vira gap audível, então o pipeline
mantém um buffer à frente do playhead e um *watchdog* que detecta starvation e
re-agenda.

## 2. Parser WebM/EBML próprio

Para decodificar um chunk arbitrário sem decodificar tudo que veio antes, é preciso
saber onde cada pacote Opus começa no arquivo.

Foi escrito um **parser EBML mínimo** que percorre
`EBML header → Segment → Info + Tracks + Clusters → SimpleBlocks` e extrai só a
tabela de amostras: timestamp absoluto, offset em bytes e tamanho de cada pacote —
mais o `decoderConfig` (codec, sample rate, canais). Nenhum áudio é decodificado
nessa etapa. Com essa tabela, o pipeline pede ao `AudioDecoder` exatamente a faixa
de bytes do intervalo que vai tocar.

## 3. Cache em OPFS (e por que não IndexedDB)

A primeira versão guardava o áudio convertido em **IndexedDB**. Gravar ~112MB por
música e rodar o enforce de cota a cada escrita disparava *compaction* do LevelDB
**no processo do browser** — o que travava **todas as abas**, não só a do app.

A troca foi para **OPFS** (Origin Private File System), gravando direto em arquivo
com `createSyncAccessHandle` dentro de um Worker: sem LevelDB, sem structured-clone
no store, sem compaction — e portanto sem freeze global. IndexedDB ficou só como
fallback para browsers sem OPFS.

Um detalhe sutil que custou tempo: `cachePut` faz `postMessage(buffer)` **sem
transfer**, no mesmo tick da chamada. O structured-clone copia os bytes na hora, o
que torna a operação segura mesmo quando o chamador transfere o `ArrayBuffer` logo
em seguida (o parser transfere → *detach*). O cache antigo guardava só a referência
e escrevia depois: gravava um buffer já *detached*, e nada era realmente cacheado.

## 4. Detecção de seções e de acordes (MIR client-side)

Duas features de análise, ambas com pipeline MIR clássico — sem modelo treinado:

**Seções** (intro, verso, refrão…): downmix para mono → **cromagrama** →
matriz de auto-similaridade (SSM) → **novelty de Foote** → detecção de picos →
rotulagem por repetição. Contra super-segmentação, o threshold de pico é
`0.7 × desvio-padrão` e seções menores que 2 compassos são fundidas ao vizinho do
mesmo cluster antes da rotulagem.

**Acordes**: cromagrama → correlação com **24 templates de tríade** (12 maiores +
12 menores) → moda por janela → merge de segmentos iguais. Saída em notação EN
(`C`, `Am`, `F#m`), transponível no render.

### O problema de GC que forçou o Worker

Rodar essa análise na main thread travava a UI por **180–510ms** por janela. A causa
não era o cálculo em si e sim **GC major**: o cromagrama aloca 4600+ `Float32Array`
e o heap de áudio fica residente. Yield cooperativo não resolve GC.

A solução foi mover **todo o DSP** (FFT, croma, Foote, templates) para um Web
Worker. A main thread faz só o downmix (uma alocação) e recebe um JSON pequeno de
volta. O Worker é criado por execução e recebe `terminate()` no fim, então o heap da
análise (~50MB de mono + frames) é liberado de forma determinística, sem resíduo
entre detecções.

Os resultados são persistidos em IndexedDB (`doxa-chords`) para não reprocessar.

## 5. O que está neste repositório

Ficou a camada de infraestrutura e a API, que mostram a arquitetura sem entregar o
motor:

| Caminho | O que é |
|---|---|
| `src/app/api/multitracks/upload-multipart/` | Upload multipart direto pro Cloudflare R2 — `create`, `sign-part`, `complete`, `abort` |
| `src/app/api/multitracks/url/` · `urls/` | Geração de URLs assinadas para leitura |
| `src/lib/audioEngine/audioFsCache.ts` | Cache OPFS com fallback IndexedDB (seção 3) |
| `src/lib/multitrackDB.ts` | Metadados das músicas e faixas |
| `src/lib/audioEnv.ts` · `iosAudioUnlock.ts` | Detecção de capacidades e unlock do `AudioContext` no iOS |

Omitidos: `chunkPipeline.ts`, `chunkDecoder.worker.ts`, `webmParser.ts`,
`detectWorker.ts`, `chordDetect.ts`, `sectionDetect.ts` e a UI do player, mixer e
editor de arranjo.
