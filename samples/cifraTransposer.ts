import { Chord, Note, Interval } from 'tonal'

export const TONS_PT = [
  'Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si',
]

const PT_TO_EN: Record<string, string> = {
  'Dó': 'C', 'Dó#': 'C#', 'Ré': 'D', 'Ré#': 'D#', 'Mi': 'E',
  'Fá': 'F', 'Fá#': 'F#', 'Sol': 'G', 'Sol#': 'G#', 'Lá': 'A', 'Lá#': 'A#', 'Si': 'B',
}

export function calcularSemitoms(origem: string, destino: string): number {
  const o = Note.get(PT_TO_EN[origem] ?? origem)
  const d = Note.get(PT_TO_EN[destino] ?? destino)
  if (o.empty || d.empty || o.chroma == null || d.chroma == null) return 0
  return ((d.chroma - o.chroma) + 12) % 12
}

export function isChordLine(linha: string): boolean {
  if (!linha.trim()) return false
  const tokens = linha.trim().split(/\s+/)
  let ok = 0, fail = 0
  for (const tok of tokens) {
    let clean = tok
      .replace(/\([^)]*\)/g, '')           // remove extensões entre parênteses: (11), (add9), (b5)
      .replace(/^[(|\-]+|[)|\-x\d]+$/g, '') // remove marcadores externos: |, -, x2
    if (!clean) continue
    const root = clean.split('/')[0]
    let c = Chord.get(root)
    if (!c.tonic || c.empty) {
      // Normaliza notação com número solto: A2→Aadd2, D4→Dsus4, G6→Gadd6
      const alt = root.replace(/^([A-G][#b]?(?:m(?:aj)?|M|dim|aug|sus)?)(\d+)$/, '$1add$2')
      c = Chord.get(alt)
    }
    c.tonic && !c.empty ? ok++ : fail++
  }
  return ok > 0 && fail === 0
}

function transposeToken(token: string, itvl: string): string {
  // Slash chord: Am/E — transpose both root and bass
  const slash = token.indexOf('/')
  if (slash > 0) {
    return transposeToken(token.slice(0, slash), itvl) + '/' + transposeToken(token.slice(slash + 1), itvl)
  }
  const chord = Chord.get(token)
  if (!chord.tonic || chord.empty) return token
  const newTonic = Note.pitchClass(Note.transpose(chord.tonic, itvl))
  return newTonic + token.slice(chord.tonic.length)
}

// Matches chord tokens: C, Am, F#m7, Bbsus4, G7, Dm/F, etc.
const CHORD_RE = /([A-G][#b]?(?:m(?:aj)?|M|dim|aug|sus[24]?|add\d+)?(?:\d+)?(?:\/[A-G][#b]?)?)/g

export function transporCifra(texto: string, semitones: number): string {
  if (!semitones || !texto) return texto
  const itvl = Interval.fromSemitones(((semitones % 12) + 12) % 12)
  return texto
    .split('\n')
    .map(linha => {
      if (/^\[.+\]$/.test(linha)) return linha
      if (!isChordLine(linha)) return linha
      return linha.replace(CHORD_RE, match => {
        const c = Chord.get(match.split('/')[0])
        return c.tonic && !c.empty ? transposeToken(match, itvl) : match
      })
    })
    .join('\n')
}
