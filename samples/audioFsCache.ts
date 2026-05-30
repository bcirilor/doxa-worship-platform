/**
 * Audio FS cache — OPFS (Origin Private File System) com fallback IndexedDB.
 *
 * Por quê OPFS: o cache antigo vivia em IndexedDB (LevelDB). Gravar ~112MB/música
 * + rodar enforceQuota a cada write disparava compaction do LevelDB no *browser
 * process*, travando TODAS as abas ("abrir aba nova trava"). OPFS grava direto em
 * arquivo via createSyncAccessHandle dentro de um Worker — sem LevelDB, sem
 * structured-clone no store, sem compaction → sem freeze global.
 *
 * Captura síncrona: cachePut faz postMessage(buffer) SEM transfer no mesmo tick em
 * que é chamado. O structured-clone do postMessage copia os bytes na hora, então é
 * seguro mesmo que o caller transfira o ArrayBuffer logo em seguida (parseOnWorker
 * faz transfer → detach). O cache IDB antigo guardava só a *referência* e escrevia
 * depois → gravava buffer já detached → nada era cacheado. OPFS corrige isso.
 *
 * Suporte: Chrome 102+, Safari 16.4+, FF 111+. Abaixo disso → fallback IndexedDB.
 */

// ── Config de cache ───────────────────────────────────────────────────────────
// Dev (localhost) acumula lixo de HMR → cap menor.
const _isLocalhost =
  typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
const CACHE_CAP_BYTES = _isLocalhost ? 200 * 1024 * 1024 : 600 * 1024 * 1024

// ── OPFS Worker (sync access handle só existe dentro de um Worker) ─────────────
// Inline como Blob URL — evita problemas de bundling de Worker no Turbopack/Webpack
// (mesmo padrão de chunkPipeline.ts). JS puro pois usa só APIs nativas do browser.
const OPFS_WORKER_CODE = /* javascript */ `
var rootDir = null;
var meta = {};               // name -> { bytes, lastAccess }
var metaLoaded = false;
var CAP = 600 * 1024 * 1024;
var ENFORCE_EVERY = 8;
var putsSinceEnforce = 0;
var metaDirty = false, metaTimer = null;

// Serializa TODAS as ops numa única fila — garante 0 sync handles concorrentes no
// mesmo arquivo (Chrome lança InvalidStateError) e replica a escrita serial antiga.
var chain = Promise.resolve();
function enqueue(fn) { var r = chain.then(fn); chain = r.catch(function(){}); return r; }

function flatten(key) { return key.replace(/\\//g, '__'); }

async function getRoot() {
  if (!rootDir) rootDir = await navigator.storage.getDirectory();
  return rootDir;
}

async function loadMeta() {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    var root = await getRoot();
    var fh = await root.getFileHandle('__meta.json', { create: false });
    var f = await fh.getFile();
    meta = JSON.parse(await f.text()) || {};
  } catch (e) { meta = {}; }
}

async function persistMetaNow() {
  try {
    var root = await getRoot();
    var fh = await root.getFileHandle('__meta.json', { create: true });
    var h = await fh.createSyncAccessHandle();
    try {
      var data = new TextEncoder().encode(JSON.stringify(meta));
      h.truncate(0); h.write(data, { at: 0 }); h.flush();
    } finally { h.close(); }
    metaDirty = false;
  } catch (e) {}
}
function scheduleMetaPersist() {
  metaDirty = true;
  if (metaTimer) return;
  metaTimer = setTimeout(function () {
    metaTimer = null;
    if (metaDirty) enqueue(persistMetaNow);
  }, 3000);
}

async function doPut(key, buffer) {
  await loadMeta();
  var root = await getRoot();
  var name = flatten(key);
  var fh = await root.getFileHandle(name, { create: true });
  var h = await fh.createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(new Uint8Array(buffer), { at: 0 });
    h.flush();
  } finally { h.close(); }
  meta[name] = { bytes: buffer.byteLength, lastAccess: Date.now() };
  scheduleMetaPersist();
  if (++putsSinceEnforce >= ENFORCE_EVERY) { putsSinceEnforce = 0; await doEnforce(); }
}

async function doGet(key) {
  await loadMeta();
  var root = await getRoot();
  var name = flatten(key);
  var fh;
  try { fh = await root.getFileHandle(name, { create: false }); }
  catch (e) { return null; }   // NotFoundError → cache miss
  var h = await fh.createSyncAccessHandle();
  var buf;
  try {
    var size = h.getSize();
    buf = new ArrayBuffer(size);
    h.read(new Uint8Array(buf), { at: 0 });
  } finally { h.close(); }
  var m = meta[name], now = Date.now();
  if (!m || now - (m.lastAccess || 0) > 3600000) {  // LRU bump throttled (>1h)
    meta[name] = { bytes: buf.byteLength, lastAccess: now };
    scheduleMetaPersist();
  }
  return buf;
}

async function doEnforce() {
  await loadMeta();
  var keys = Object.keys(meta), total = 0, i;
  for (i = 0; i < keys.length; i++) total += (meta[keys[i]].bytes || 0);
  if (total <= CAP) return;
  keys.sort(function (a, b) { return (meta[a].lastAccess || 0) - (meta[b].lastAccess || 0); }); // mais antigo 1º
  var root = await getRoot();
  for (i = 0; i < keys.length && total > CAP; i++) {
    var k = keys[i];
    try { await root.removeEntry(k); } catch (e) {}
    total -= (meta[k].bytes || 0);
    delete meta[k];
  }
  scheduleMetaPersist();
}

// Cria + escreve + apaga um arquivo de prova: confirma createSyncAccessHandle de fato
// funcional (não basta existir — Safari <16.4 não tem; alguns ctx bloqueiam).
async function probe() {
  try {
    if (typeof self.navigator === 'undefined' || !self.navigator.storage ||
        typeof self.navigator.storage.getDirectory !== 'function') return false;
    var root = await getRoot();
    var fh = await root.getFileHandle('__probe', { create: true });
    if (typeof fh.createSyncAccessHandle !== 'function') return false;
    var h = await fh.createSyncAccessHandle();
    try { h.truncate(0); h.write(new Uint8Array([1]), { at: 0 }); h.flush(); } finally { h.close(); }
    try { await root.removeEntry('__probe'); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.op === 'init') {
    if (msg.cap) CAP = msg.cap;
    enqueue(probe).then(function (ok) {
      if (ok) enqueue(function () { return loadMeta().then(doEnforce); });
      self.postMessage({ type: 'ready', ok: !!ok });
    }).catch(function () { self.postMessage({ type: 'ready', ok: false }); });
    return;
  }
  if (msg.op === 'get') {
    enqueue(function () { return doGet(msg.key); }).then(function (buf) {
      if (buf) self.postMessage({ type: 'got', id: msg.id, buffer: buf }, [buf]);
      else self.postMessage({ type: 'got', id: msg.id, buffer: null });
    }).catch(function () { self.postMessage({ type: 'got', id: msg.id, buffer: null }); });
    return;
  }
  if (msg.op === 'put') {
    enqueue(function () { return doPut(msg.key, msg.buffer); }).then(function () {
      self.postMessage({ type: 'done', id: msg.id });
    }).catch(function () { self.postMessage({ type: 'done', id: msg.id }); });
    return;
  }
};
`

// ── Main-thread driver ─────────────────────────────────────────────────────────

type Backend = 'opfs' | 'idb'

let _worker: Worker | null = null
let _backend: Promise<Backend> | null = null
let _backendResolved: Backend | null = null   // versão síncrona p/ o fast-path de cachePut
let _workerBlobUrl: string | null = null
let _msgId = 0
const _getPending = new Map<number, (buf: ArrayBuffer | null) => void>()

function degradeToIdb(): void {
  _backendResolved = 'idb'
  const w = _worker
  _worker = null
  if (w) { try { w.terminate() } catch { /* silent */ } }
  // resolve gets pendentes como miss → caller re-baixa do R2
  for (const resolve of _getPending.values()) resolve(null)
  _getPending.clear()
}

function handleWorkerMessage(e: MessageEvent): void {
  const d = e.data
  if (d?.type === 'got') {
    const r = _getPending.get(d.id)
    if (r) { _getPending.delete(d.id); r(d.buffer ?? null) }
  }
  // 'done' (put ack) ignorado — cachePut é fire-and-forget
}

function initBackend(): Promise<Backend> {
  if (_backend) return _backend
  _backend = new Promise<Backend>((resolve) => {
    if (
      typeof window === 'undefined' || typeof Worker === 'undefined' ||
      typeof navigator === 'undefined' || !navigator.storage ||
      typeof navigator.storage.getDirectory !== 'function'
    ) { _backendResolved = 'idb'; resolve('idb'); return }

    try {
      if (!_workerBlobUrl) {
        const blob = new Blob([OPFS_WORKER_CODE], { type: 'application/javascript' })
        _workerBlobUrl = URL.createObjectURL(blob)
      }
      const w = new Worker(_workerBlobUrl)
      let settled = false
      const finish = (b: Backend, keep: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(to)
        _backendResolved = b
        if (keep) { _worker = w; w.onmessage = handleWorkerMessage; w.onerror = () => degradeToIdb() }
        else { try { w.terminate() } catch { /* silent */ } }
        resolve(b)
      }
      const to = setTimeout(() => finish('idb', false), 3000)  // handshake travou → IDB
      w.onmessage = (ev) => { if (ev.data?.type === 'ready') finish(ev.data.ok ? 'opfs' : 'idb', !!ev.data.ok) }
      w.onerror = () => finish('idb', false)
      w.postMessage({ op: 'init', cap: CACHE_CAP_BYTES })
    } catch { _backendResolved = 'idb'; resolve('idb') }
  })
  return _backend
}

/** Lê do cache. Devolve ArrayBuffer (cópia transferida do worker) ou null (miss). */
export async function cacheGet(key: string): Promise<ArrayBuffer | null> {
  const backend = await initBackend()
  if (backend === 'opfs' && _worker) {
    const id = ++_msgId
    return new Promise<ArrayBuffer | null>((resolve) => {
      _getPending.set(id, resolve)
      _worker!.postMessage({ op: 'get', id, key })
    })
  }
  return idbGet(key)
}

/**
 * Grava no cache (fire-and-forget). No path OPFS, posta o buffer SEM transfer no
 * fast-path síncrono → o structured-clone copia os bytes neste tick, antes do caller
 * transferir o ArrayBuffer (parseOnWorker). Custo: 1 cópia transitória (~7MB) por
 * download, drenada rápido pelo worker (escrita em disco é muito mais veloz que a rede).
 */
export function cachePut(key: string, buffer: ArrayBuffer): void {
  if (_backendResolved === 'opfs' && _worker) {       // fast-path síncrono (caso comum)
    _worker.postMessage({ op: 'put', id: ++_msgId, key, buffer })
    return
  }
  if (_backendResolved === 'idb') { idbSchedule(key, buffer); return }
  // backend ainda não resolveu (raro: 1º put antes do handshake) — resolve async.
  // cacheGet roda antes de qualquer download e aguarda initBackend, então na prática
  // o backend já está resolvido aqui.
  initBackend().then((b) => {
    if (b === 'opfs' && _worker) _worker.postMessage({ op: 'put', id: ++_msgId, key, buffer })
    else idbSchedule(key, buffer)
  }).catch(() => { /* silent */ })
}

/** Retoma a fila de writes do IDB após a aba voltar ao foco. No-op no path OPFS. */
export function cacheResume(): void {
  if (_backendResolved === 'opfs') return  // worker grava em thread própria — sem freeze de tab switch
  drainIDBWriteQueue().catch(() => { /* silent */ })
}

// ── Fallback IndexedDB ─────────────────────────────────────────────────────────
// Path legado para browsers sem OPFS (Safari <16.4 — raro). Movido de multitrackDB.ts.
// Serializa writes (DL_CONCURRENCY=3 disparava 3 puts ~7MB simultâneos → satura o I/O
// thread do LevelDB → trava o browser ao trocar de aba). Pausa em aba oculta.
const AUDIO_CACHE_DB = 'doxa-audio-cache-v5'
const AUDIO_CACHE_STORE = 'buffers'
const AUDIO_META_STORE = 'meta'   // cacheKey → { bytes, lastAccess }
const LEGACY_DBS = ['doxa-audio-cache', 'doxa-audio-cache-v2', 'doxa-audio-cache-v3', 'doxa-audio-cache-v4']
const LRU_BUMP_THROTTLE_MS = 60 * 60 * 1000   // só reescreve lastAccess se > 1h

let legacyPurged = false
function purgeLegacyDBs() {
  if (legacyPurged || typeof indexedDB === 'undefined') return
  legacyPurged = true
  for (const name of LEGACY_DBS) {
    try { indexedDB.deleteDatabase(name) } catch { /* silent */ }
  }
}

let _startupTrimDone = false
function openAudioCacheDB(): Promise<IDBDatabase> {
  purgeLegacyDBs()
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_CACHE_DB, 1)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(AUDIO_CACHE_STORE))
        db.createObjectStore(AUDIO_CACHE_STORE)
      if (!db.objectStoreNames.contains(AUDIO_META_STORE))
        db.createObjectStore(AUDIO_META_STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      if (!_startupTrimDone) { _startupTrimDone = true; enforceIdbQuota(db).catch(() => {}) }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
}

// LRU bump throttled — fire-and-forget, não bloqueia o read.
function bumpLastAccess(db: IDBDatabase, key: string, bytes: number) {
  try {
    const tx = db.transaction(AUDIO_META_STORE, 'readwrite')
    const store = tx.objectStore(AUDIO_META_STORE)
    const g = store.get(key)
    g.onsuccess = () => {
      const now = Date.now()
      const m = g.result as { bytes: number; lastAccess: number } | undefined
      if (!m || now - (m.lastAccess || 0) > LRU_BUMP_THROTTLE_MS)
        store.put({ bytes: m?.bytes ?? bytes, lastAccess: now }, key)
    }
  } catch { /* silent */ }
}

let _quotaRunning = false
async function enforceIdbQuota(db: IDBDatabase): Promise<void> {
  if (_quotaRunning) return
  _quotaRunning = true
  try {
    const entries = await new Promise<{ key: IDBValidKey; bytes: number; lastAccess: number }[]>((resolve) => {
      const out: { key: IDBValidKey; bytes: number; lastAccess: number }[] = []
      const tx = db.transaction(AUDIO_META_STORE, 'readonly')
      const cur = tx.objectStore(AUDIO_META_STORE).openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (c) {
          const v = (c.value || {}) as { bytes?: number; lastAccess?: number }
          out.push({ key: c.key, bytes: v.bytes || 0, lastAccess: v.lastAccess || 0 })
          c.continue()
        } else resolve(out)
      }
      cur.onerror = () => resolve(out)
    })
    let total = entries.reduce((s, e) => s + e.bytes, 0)
    if (total <= CACHE_CAP_BYTES) return
    entries.sort((a, b) => a.lastAccess - b.lastAccess)  // mais antigo primeiro
    await new Promise<void>((resolve) => {
      const tx = db.transaction([AUDIO_CACHE_STORE, AUDIO_META_STORE], 'readwrite')
      const bufStore = tx.objectStore(AUDIO_CACHE_STORE)
      const metaStore = tx.objectStore(AUDIO_META_STORE)
      for (const e of entries) {
        if (total <= CACHE_CAP_BYTES) break
        bufStore.delete(e.key)
        metaStore.delete(e.key)
        total -= e.bytes
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch { /* silent */ } finally { _quotaRunning = false }
}

async function idbGet(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openAudioCacheDB()
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_CACHE_STORE, 'readonly')
      const req = tx.objectStore(AUDIO_CACHE_STORE).get(key)
      req.onsuccess = () => {
        const buf = (req.result as ArrayBuffer) ?? null
        if (buf) bumpLastAccess(db, key, buf.byteLength)
        resolve(buf)
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function idbSet(key: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openAudioCacheDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction([AUDIO_CACHE_STORE, AUDIO_META_STORE], 'readwrite')
      tx.objectStore(AUDIO_CACHE_STORE).put(buffer, key)
      tx.objectStore(AUDIO_META_STORE).put({ bytes: buffer.byteLength, lastAccess: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    enforceIdbQuota(db).catch(() => {})
  } catch { /* silent */ }
}

const _idbWriteQueue: Array<{ key: string; buffer: ArrayBuffer }> = []
let _idbWriteDraining = false

async function drainIDBWriteQueue(): Promise<void> {
  if (_idbWriteDraining) return
  _idbWriteDraining = true
  while (_idbWriteQueue.length > 0) {
    // Pausa se aba oculta — LevelDB I/O durante tab switch causa freeze.
    // cacheResume() reinicia o drain quando a aba volta ao foco.
    if (typeof document !== 'undefined' && document.hidden) {
      _idbWriteDraining = false
      return
    }
    const item = _idbWriteQueue.shift()!
    await idbSet(item.key, item.buffer)
    if (_idbWriteQueue.length > 0) {
      await new Promise<void>(r =>
        typeof requestIdleCallback !== 'undefined'
          ? requestIdleCallback(() => r(), { timeout: 500 })
          : setTimeout(r, 150)
      )
    }
  }
  _idbWriteDraining = false
}

function idbSchedule(key: string, buffer: ArrayBuffer): void {
  _idbWriteQueue.push({ key, buffer })
  drainIDBWriteQueue().catch(() => {})
}
