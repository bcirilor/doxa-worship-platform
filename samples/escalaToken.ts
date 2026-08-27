/**
 * Token de confirmação de escala, assinado, sem exigir login.
 *
 * Versão ilustrativa, escrita para este repositório. Não é o arquivo que roda em
 * produção.
 *
 * O problema: o músico recebe a escala no WhatsApp e precisa confirmar presença.
 * Obrigar login para um clique perde a confirmação, e confirmação que não chega
 * vira telefonema no sábado à noite.
 *
 * A solução é um link que carrega um token assinado. Ele prova três coisas e
 * nada além: quem é o membro, que o link não foi adulterado, e que ainda está no
 * prazo. Não é sessão, não dá acesso a nada mais, e serve para uma ação só.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

/**
 * Uma chave, um propósito.
 *
 * Sem fallback para outra credencial do sistema. Cair na chave de serviço do
 * banco, por exemplo, é o tipo de atalho que funciona no primeiro dia e explode
 * depois: a credencial mais poderosa passa a assinar e-mail, e um vazamento em
 * qualquer ponta compromete as duas coisas de uma vez.
 *
 * Faltando a variável, o processo quebra ao subir. Falhar no boot é melhor que
 * assinar token com algo que não deveria assinar nada.
 */
function segredo(): string {
  const s = process.env.ESCALA_TOKEN_SECRET;
  if (!s || s.length < 32) {
    throw new Error('ESCALA_TOKEN_SECRET ausente ou curto demais (mínimo 32 bytes)');
  }
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function assina(corpo: string): string {
  return b64url(createHmac('sha256', segredo()).update(corpo).digest());
}

export function gerarToken(membroId: string, escalaId: string): string {
  // `escalaId` entra no payload de propósito. Sem ele o token confirma qualquer
  // escala do membro, e um link antigo passa a valer para a próxima.
  const payload = { m: membroId, e: escalaId, exp: Date.now() + TTL_MS };
  const corpo = b64url(Buffer.from(JSON.stringify(payload)));
  return `${corpo}.${assina(corpo)}`;
}

export function verificarToken(
  token: string,
): { membroId: string; escalaId: string } | null {
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [corpo, assinatura] = partes;

  const esperada = Buffer.from(assina(corpo));
  const recebida = Buffer.from(assinatura);

  // Comparar tamanho antes: `timingSafeEqual` lança com buffers de tamanhos
  // diferentes. E a comparação precisa ser de tempo constante, senão o tempo de
  // resposta entrega quantos bytes iniciais o atacante já acertou.
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  try {
    const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (typeof p.m !== 'string' || typeof p.e !== 'string') return null;
    if (typeof p.exp !== 'number' || Date.now() > p.exp) return null;
    return { membroId: p.m, escalaId: p.e };
  } catch {
    return null;
  }
}
