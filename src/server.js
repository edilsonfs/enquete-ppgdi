import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { PERGUNTAS, validarResposta } from './perguntas.js';
import { salvarResposta, resultados, limparTudo } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORTA = Number(process.env.PORT) || 8080;

const URL_ENQUETE = process.env.URL_ENQUETE || 'https://enquete.lexcode.tech';
const URL_LINKS = process.env.URL_LINKS || 'https://links.lexcode.tech';
const HOST_LINKS = new URL(URL_LINKS).hostname;

app.disable('x-powered-by');

/*
 * Cabeçalhos de segurança. O front-end usa <style> e <script> inline, por isso
 * script-src/style-src precisam de 'unsafe-inline'; todo o resto fica em 'self'.
 * Nenhum recurso externo é carregado — o QR code é SVG gerado aqui.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/') || req.path === '/health') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use(express.json({ limit: '64kb' }));
app.use(express.static(join(__dirname, '..', 'public'), { index: false }));

const pagina = (nome) => (_req, res) => res.sendFile(join(__dirname, '..', 'public', nome));

/* ------------------------------------------------------------------ *
 * Páginas
 * ------------------------------------------------------------------ */

/**
 * Os dois domínios apontam para o mesmo container; quem decide o que servir na
 * raiz é o Host. Assim um app só atende enquete.lexcode.tech e
 * links.lexcode.tech, sem duplicar deploy, volume e certificado.
 */
app.get('/', (req, res, next) => {
  if (req.hostname === HOST_LINKS) return pagina('links.html')(req, res, next);
  return pagina('enquete.html')(req, res, next);
});

// Rotas explícitas: funcionam em qualquer domínio, inclusive antes do DNS existir.
app.get('/links', pagina('links.html'));
app.get('/resultado', pagina('resultado.html'));
app.get('/nuvem', pagina('resultado.html')); // a nuvem vive na mesma tela
app.get('/qrcode', pagina('qrcode.html'));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    servico: 'enquete-ppgdi',
    perguntas: PERGUNTAS.length,
    url_enquete: URL_ENQUETE,
    url_links: URL_LINKS,
  });
});

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

app.get('/api/perguntas', (_req, res) => {
  res.json({ perguntas: PERGUNTAS, url_enquete: URL_ENQUETE, url_links: URL_LINKS });
});

const ultimoEnvio = new Map();
const INTERVALO_MIN_MS = 2000;

app.post('/api/respostas', (req, res) => {
  // Trava só contra duplo-clique. A enquete é anônima e a sala inteira responde
  // do mesmo Wi-Fi, então bloquear por IP por mais tempo excluiria gente.
  const chave = req.ip ?? 'anon';
  if (Date.now() - (ultimoEnvio.get(chave) ?? 0) < INTERVALO_MIN_MS) {
    return res.status(429).json({ erro: 'Aguarde um instante antes de reenviar.' });
  }

  let limpa;
  try {
    limpa = validarResposta(req.body);
  } catch (err) {
    return res.status(400).json({ erro: err.message });
  }

  ultimoEnvio.set(chave, Date.now());
  salvarResposta(limpa);
  res.status(201).json({ ok: true, ...resultados() });
});

app.get('/api/resultados', (_req, res) => res.json(resultados()));

/** QR code da enquete, em SVG — escala sem borrar no projetor. */
app.get('/api/qrcode.svg', async (req, res) => {
  const destino = String(req.query.url || URL_ENQUETE);
  if (!/^https?:\/\//.test(destino)) {
    return res.status(400).json({ erro: 'URL inválida.' });
  }
  try {
    const svg = await QRCode.toString(destino, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0b1a26', light: '#ffffff' },
    });
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=3600').send(svg);
  } catch {
    res.status(500).json({ erro: 'Não foi possível gerar o QR code.' });
  }
});

/** Zera as respostas entre turmas. Exige ADMIN_TOKEN. */
app.post('/api/admin/reset', (req, res) => {
  const esperado = process.env.ADMIN_TOKEN;
  const recebido = req.get('x-admin-token') ?? '';
  const ok =
    Boolean(esperado) &&
    recebido.length === esperado.length &&
    timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
  if (!ok) return res.status(401).json({ erro: 'Não autorizado.' });

  const apagados = limparTudo();
  console.log(`[admin] reset: ${apagados.respostas} respostas`);
  res.json({ ok: true, ...apagados });
});

app.listen(PORTA, '0.0.0.0', () => {
  console.log(`[enquete-ppgdi] ouvindo na porta ${PORTA}`);
  console.log(`[enquete-ppgdi] enquete: ${URL_ENQUETE} | links: ${URL_LINKS}`);
});
