# Doxa, worship team platform

Management platform for church worship teams: scheduling, availability, song library,
chord charts and an in-browser multitrack player. Real application, in production,
multi-tenant.

> **This repository is an excerpt, and the samples are illustrative.** The full
> application is private. What is here is one architecture document and three files
> that carry the decisions worth reading, rewritten for publication rather than
> copied from production. It does not build or run on its own.

**Stack:** Next.js (App Router), React, TypeScript, Tailwind CSS, Supabase (Postgres
with Row Level Security), Vercel.

## The multitrack engine

[`docs/MULTITRACKS.md`](docs/MULTITRACKS.md) is the part worth reading. A song is a
set of separate stems (click, guide, drums, bass, keys, pads, guitar, vocals) played
in sync in the browser, with a per-track mixer, PA and in-ear routing, an arrangement
editor and synced chord charts. All client side: no audio server, no ML, no remote
processing.

Eight stems of five minutes decoded into `AudioBuffer`s take roughly 400MB of RAM,
which kills the tab on a phone. The document describes the fix, decoding on demand in
3 second blocks through WebCodecs in a `Worker`, with a 30ms crossfade, and the
problems that surfaced along the way.

`samples/audioFsCache.ts` is the storage side of the same engine. The cache used to
live in IndexedDB, and writing around 112MB per song through LevelDB froze every open
tab. It now writes straight to OPFS through a `Worker` with a sync access handle,
keeping IndexedDB only as the fallback for browsers below Chrome 102, Safari 16.4 and
Firefox 111.

## Two other decisions

**`samples/escalaToken.ts`.** Confirming a schedule should not require a login. The
link carries an HMAC-SHA256 token over `{ member id, expiry }` with a 30 day TTL,
verified with a constant time comparison. A musician taps the link in WhatsApp and is
confirmed, and the token cannot be forged or replayed past its expiry.

**`samples/cifraTransposer.ts`.** Chord chart transposition built on `tonal`, so
chords are parsed rather than string-replaced. It also carries both notations, the
Latin one the Brazilian musician reads on the page (Do, Re, Mi) and the English one
the library speaks (C, D, E), and converts between them.

## License

All rights reserved. See [LICENSE](LICENSE). Published to be read and reviewed, not
reused.
