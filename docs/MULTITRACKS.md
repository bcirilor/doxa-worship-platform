# Multitrack engine — architecture

> The code for this module is **not** part of the public repository. This document
> describes how it works, the problems that showed up along the way, and the
> decision that resolved each one.

DoxaApp plays **multitracks** in the browser: a song is a set of separate stems
(click, guide, drums, bass, keys, pads, guitar, vocals) played in sync, with a
per-track mixer, PA/in-ear routing, an arrangement editor, synced chord charts and
automatic section and chord detection. All client-side — no audio server, no ML, no
remote processing.

## 1. Chunked playback (the memory problem)

A song with 8 stems of 5 minutes, decoded into `AudioBuffer`s, occupies roughly
400MB of RAM. On a phone that kills the tab.

The fix was to **decode on demand in 3-second blocks**, with a 30ms crossfade
between them:

- a `Worker` decodes each chunk through **WebCodecs** (`AudioDecoder`);
- each chunk becomes an `AudioBufferSourceNode` scheduled sequentially on the
  `AudioContext`, at its exact time;
- blocks already played are discarded.

The result is roughly **1MB of RAM per track** instead of ~400MB total. The cost is
scheduling precision — any delay in decoding turns into an audible gap — so the
pipeline keeps a buffer ahead of the playhead plus a watchdog that detects
starvation and reschedules.

## 2. A hand-written WebM/EBML parser

To decode an arbitrary chunk without decoding everything before it, you need to know
where each Opus packet begins in the file.

So the engine includes a **minimal EBML parser** that walks
`EBML header → Segment → Info + Tracks + Clusters → SimpleBlocks` and extracts only
the sample table: absolute timestamp, byte offset and length of each packet, plus
the `decoderConfig` (codec, sample rate, channels). No audio is decoded at this
stage. With that table, the pipeline hands `AudioDecoder` exactly the byte range for
the interval about to play.

## 3. OPFS caching (and why not IndexedDB)

The first version stored converted audio in **IndexedDB**. Writing ~112MB per song
and running quota enforcement on every write triggered LevelDB **compaction in the
browser process** — which froze **every tab**, not just the app's.

The replacement was **OPFS** (Origin Private File System), writing straight to a
file with `createSyncAccessHandle` inside a Worker: no LevelDB, no structured clone
into the store, no compaction — and therefore no global freeze. IndexedDB stayed on
only as a fallback for browsers without OPFS.

One subtle detail cost real time here: `cachePut` calls `postMessage(buffer)`
**without transfer**, in the same tick it is invoked. The structured clone copies the
bytes right then, which makes the call safe even when the caller transfers the
`ArrayBuffer` immediately afterwards (the parser transfers it → detach). The old
IndexedDB cache stored only the reference and wrote later — so it wrote an
already-detached buffer, and nothing was ever actually cached.

## 4. Section and chord detection (client-side MIR)

Two analysis features, both classic MIR pipelines — no trained model:

**Sections** (intro, verse, chorus…): downmix to mono → **chromagram** →
self-similarity matrix (SSM) → **Foote novelty** → peak picking → labelling by
repetition. To counter over-segmentation, the peak threshold is
`0.7 × standard deviation`, and sections shorter than 2 bars are merged into the
neighbour from the same cluster before labelling.

**Chords**: chromagram → correlation against **24 triad templates** (12 major, 12
minor) → mode per window → merge of identical neighbouring segments. Output is in
English notation (`C`, `Am`, `F#m`), transposable at render time.

### The GC problem that forced a Worker

Running this analysis on the main thread froze the UI for **180–510ms** per window.
The cause was not the arithmetic but **major GC**: the chromagram allocates 4600+
`Float32Array`s while the audio heap stays resident. Cooperative yielding does not
help against GC.

The fix was to move **all the DSP** (FFT, chroma, Foote, template matching) into a
Web Worker. The main thread only performs the downmix — a single allocation — and
receives a small JSON back. The Worker is created per run and gets `terminate()`d at
the end, so the analysis heap (~50MB of mono audio plus frames) is released
deterministically, with nothing left over between runs.

Results are persisted to IndexedDB (`doxa-chords`) to avoid recomputation.

## 5. What is in this repository

The infrastructure and API layers stayed, which show the architecture without
handing over the engine:

| Path | What it is |
|---|---|
| `src/app/api/multitracks/upload-multipart/` | Multipart upload straight to Cloudflare R2 — `create`, `sign-part`, `complete`, `abort` |
| `src/app/api/multitracks/url/` · `urls/` | Signed read URL generation |
| `src/lib/audioEngine/audioFsCache.ts` | OPFS cache with IndexedDB fallback (section 3) |
| `src/lib/multitrackDB.ts` | Song and stem metadata |
| `src/lib/audioEnv.ts` · `iosAudioUnlock.ts` | Capability detection and `AudioContext` unlocking on iOS |

Withheld: `chunkPipeline.ts`, `chunkDecoder.worker.ts`, `webmParser.ts`,
`detectWorker.ts`, `chordDetect.ts`, `sectionDetect.ts`, and the player, mixer and
arrangement editor UI.
