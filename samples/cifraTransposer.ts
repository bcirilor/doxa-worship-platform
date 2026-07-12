import { Chord, Note, Interval } from 'tonal'

export const TONS_PT = [
  'Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si',
]

export const TONS_EN = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]

const PT_TO_EN: Record<string, string> = {
  'Dó': 'C', 'Dó#': 'C#', 'Ré': 'D', 'Ré#': 'D#', 'Mi': 'E',
  'Fá': 'F', 'Fá#': 'F#', 'Sol': 'G', 'Sol#': 'G#', 'Lá': 'A', 'Lá#': 'A#', 'Si': 'B',
}

// PT mais longo primeiro p/ "Dó#" casar antes de "Dó"
const TONS_PT_DESC = [...TONS_PT].sort((a, b) => b.length - a.length)

// Raiz (nota EN) de um rótulo de tom. Aceita PT (Dó, Sol#), EN (C, G#) com
// menor/7/sus etc.: "Am" → "A", "Sol#m7" → "G#", "Bb" → "Bb".
function rootNote(tom: string): string {
  const ptRoot = TONS_PT_DESC.find(t => tom.startsWith(t))
  if (ptRoot) return PT_TO_EN[ptRoot]
  const m = tom.match(/^([A-G][#b]?)/)
  return m ? m[1] : tom
}

export function calcularSemitoms(origem: string, destino: string): number {
  const o = Note.get(rootNote(origem))
  const d = Note.get(rootNote(destino))
  if (o.empty || d.empty || o.chroma == null || d.chroma == null) return 0
  return ((d.chroma - o.chroma) + 12) % 12
}

// Converte rótulo de tom p/ notação EN (cifra padrão), preservando sufixo: "Sol#m" → "G#m".
// Já em EN → retorna como está.
export function paraNotacaoEN(tom: string): string {
  if (!tom) return tom
  const ptRoot = TONS_PT_DESC.find(t => tom.startsWith(t))
  if (!ptRoot) return tom
  return PT_TO_EN[ptRoot] + tom.slice(ptRoot.length)
}

// Transpõe um rótulo de tom por N semitons, preservando notação (PT/EN) e
// sufixo (menor, 7, sus...). "G"→+2→"A" · "Am"→+1→"Bbm" · "Sol"→+1→"Sol#".
// Casa a grafia (bemóis) com transporCifra p/ tom e acordes baterem.
export function transporTom(tom: string, semitones: number): string {
  if (!tom) return tom
  const norm = ((semitones % 12) + 12) % 12
  if (norm === 0) return tom

  const ptRoot = TONS_PT_DESC.find(t => tom.startsWith(t))
  if (ptRoot) {
    const sufixo = tom.slice(ptRoot.length)
    const idx = TONS_EN.indexOf(PT_TO_EN[ptRoot])
    const novoEn = TONS_EN[(idx + norm) % 12]
    return TONS_PT[TONS_EN.indexOf(novoEn)] + sufixo
  }

  const m = tom.match(/^([A-G][#b]?)(.*)$/)
  if (!m) return tom
  const novaRaiz = Note.pitchClass(Note.transpose(m[1], Interval.fromSemitones(norm)))
  return novaRaiz ? novaRaiz + m[2] : tom
}

// Tokens neutros (não contam como ok nem fail) — barras, repetições, comentários inline, etc.
const SKIP_TOKEN_RE = /^(?:[|:]+|\d+x|x\d+|\(.*\)|--+|\.\.+)$/i

// Normaliza notação não-padrão para forma reconhecida pelo tonal
function normalizeChordToken(tok: string): string {
  return tok
    .replace(/[°º]/g, 'dim')        // C° → Cdim
    .replace(/[ΔΔ△]/g, 'maj7')      // CΔ → Cmaj7
    .replace(/(\d)M\b/g, 'maj$1')   // D7M → Dmaj7 (notação BR)
    .replace(/[♭b](?=\d)/g, 'b')    // C♭5 → Cb5 (unicode flat)
    .replace(/[♯#](?=\d)/g, '#')
}

export function isChordLine(linha: string): boolean {
  if (!linha.trim()) return false
  const tokens = linha.trim().split(/\s+/)
  let ok = 0, fail = 0
  for (const tok of tokens) {
    // Pula tokens neutros (|, x2, 2x, (dedilhado), etc.) — não pesa positivo nem negativo
    if (SKIP_TOKEN_RE.test(tok)) continue

    let clean = normalizeChordToken(tok)
      .replace(/\([^)]*\)/g, '')           // remove extensões entre parênteses: (11), (add9), (b5)
      .replace(/^[(|\-]+|[)|\-]+$/g, '')   // remove marcadores externos: |, -
    if (!clean) continue
    const root = clean.split('/')[0]
    // Acorde sempre começa com nota maiúscula A-G; tonal aceita minúsculas mas não é notação válida
    if (!/^[A-G]/.test(root)) { fail++; continue }
    let c = Chord.get(root)
    if (!c.tonic || c.empty) {
      // Normaliza notação com número solto: A2→Aadd2, D4→Dsus4, G6→Gadd6
      const alt = root.replace(/^([A-G][#b]?(?:m(?:aj)?|M|dim|aug|sus)?)(\d+)$/, '$1add$2')
      c = Chord.get(alt)
    }
    c.tonic && !c.empty ? ok++ : fail++
  }
  // Linha com 1 acorde sozinho (ex: "Bb", "Am7") é linha de acorde se zero falhas.
  // Linha com 2+ acordes: tolera 1 token estranho (ok >= fail).
  return (ok >= 1 && fail === 0) || (ok >= 2 && ok >= fail)
}

function transposeToken(token: string, itvl: string): string {
  // Slash chord: Am/E — transpose both root and bass
  const slash = token.indexOf('/')
  if (slash > 0) {
    return transposeToken(token.slice(0, slash), itvl) + '/' + transposeToken(token.slice(slash + 1), itvl)
  }
  // Normalize (7M→maj7, °→dim, etc.) for tonal lookup; preserve original suffix in output
  const chord = Chord.get(normalizeChordToken(token))
  if (!chord.tonic || chord.empty) return token
  const newTonic = Note.pitchClass(Note.transpose(chord.tonic, itvl))
  return newTonic + token.slice(chord.tonic.length)
}

// Matches chord tokens: C, Am, F#m7, Bbsus4, G7, Dm/F, D7M/A (notação BR), etc.
const CHORD_RE = /([A-G][#b]?(?:m(?:aj)?|M|dim|aug|sus[24]?|add\d+)?(?:\d+M?)?(?:\/[A-G][#b]?)?)/g

export function transporCifra(texto: string, semitones: number): string {
  if (!semitones || !texto) return texto
  const itvl = Interval.fromSemitones(((semitones % 12) + 12) % 12)
  return texto
    .split('\n')
    .map(linha => {
      if (/^\[.+\]$/.test(linha)) return linha
      if (!isChordLine(linha)) return linha
      return linha.replace(CHORD_RE, match => {
        const root = normalizeChordToken(match.split('/')[0])
        const c = Chord.get(root)
        return c.tonic && !c.empty ? transposeToken(match, itvl) : match
      })
    })
    .join('\n')
}

// Rótulo "Tom:" numa linha da cifra: "Tom: A", "Tom - Sol#m", "tom:D7M".
// Grupo 1 = prefixo (rótulo+delimitador), 2 = token do tom, 3 = resto da linha.
const TOM_LINE_RE = /^([ \t]*tom[ \t]*[:\-–][ \t]*)(\S+)([ \t]*.*)$/i

// Detecta o tom declarado na linha "Tom:" da cifra e devolve o token
// (ex.: "A", "Am7", "Sol#"), preservando a grafia. null se não houver rótulo
// reconhecível. Usado p/ pré-preencher `musicas.tom` a partir da cifra colada.
export function detectarTomNaCifra(texto: string): string | null {
  if (!texto) return null
  for (const linha of texto.split('\n')) {
    const m = linha.match(TOM_LINE_RE)
    if (!m) continue
    const tom = m[2].replace(/[.,;:]+$/, '').trim()
    if (!tom) continue
    if (!Note.get(rootNote(tom)).empty) return tom
  }
  return null
}

// Transpõe SÓ a linha "Tom:" da cifra (transporCifra a ignora — não é linha de
// acordes). Mantém rótulo, delimitador e resto da linha intactos.
export function transporLinhaTom(texto: string, semitones: number): string {
  if (!semitones || !texto) return texto
  return texto
    .split('\n')
    .map(linha => {
      const m = linha.match(TOM_LINE_RE)
      return m ? m[1] + transporTom(m[2], semitones) + m[3] : linha
    })
    .join('\n')
}
