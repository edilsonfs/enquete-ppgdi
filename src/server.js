import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

import { PERGUNTAS, validarResposta } from './perguntas.js';
import {
  salvarResposta,
  resultados,
  limparTudo,
  criarTurma,
  buscarTurma,
  listarTurmas,
  ativarTurma,
  desativarTodas,
  turmaAtiva,
  removerTurma,
  respostasSemTurma,
  turmaMaisRecente,
  obterConfig,
  definirConfig,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || './data';
const CARTILHA_PDF = join(DATA_DIR, 'cartilha.pdf');
const CARTILHA_META = join(DATA_DIR, 'cartilha.json');

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
// A cartilha sobe como corpo binário puro: evita uma dependência de multipart
// para o único upload que este app tem.
app.use('/api/admin/cartilha', express.raw({ type: 'application/pdf', limit: '25mb' }));
app.use(express.static(PUBLICO, { index: false }));

const pagina = (nome) => (_req, res) => res.sendFile(join(PUBLICO, nome));

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

app.get('/links', pagina('links.html'));
app.get('/resultado', pagina('resultado.html'));
app.get('/nuvem', pagina('nuvem.html'));
app.get('/qrcode', pagina('qrcode.html'));
app.get('/admin', pagina('admin.html'));

app.get('/health', (_req, res) => {
  const ativa = turmaAtiva();
  res.json({
    ok: true,
    servico: 'enquete-ppgdi',
    perguntas: PERGUNTAS.length,
    url_enquete: URL_ENQUETE,
    url_links: URL_LINKS,
    turma_ativa: ativa ? ativa.nome : null,
    cartilha: existsSync(CARTILHA_PDF),
  });
});

/* ------------------------------------------------------------------ *
 * API pública
 * ------------------------------------------------------------------ */

app.get('/api/perguntas', (_req, res) => {
  const ativa = turmaAtiva();
  res.json({
    perguntas: PERGUNTAS,
    url_enquete: URL_ENQUETE,
    url_links: URL_LINKS,
    // Só o nome, para a tela poder dizer discretamente de que turma se trata.
    // Nenhuma escolha é oferecida a quem responde.
    turma: ativa ? { id: ativa.id, nome: ativa.nome } : null,
  });
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

  // A turma vem do link (?t=) quando há um QR por turma; sem isso, cai na turma
  // ativa. Quem responde nunca escolhe — e nunca vê a decisão.
  const pedida = buscarTurma(req.body && req.body.turma);
  const turma = pedida || turmaAtiva();

  ultimoEnvio.set(chave, Date.now());
  salvarResposta({ ...limpa, turmaId: turma ? turma.id : null });

  // Devolve o resultado da mesma turma em que a resposta entrou, para a tela de
  // agradecimento mostrar um total coerente com o que a pessoa acabou de somar.
  res.status(201).json({ ok: true, ...resultados(turma ? turma.id : null) });
});

/**
 * Decide QUAL recorte uma tela de resultado deve mostrar.
 *
 * O padrão é a turma ativa, e não o agregado de tudo. Sem isso a nuvem
 * projetada continuava exibindo a turma anterior depois de trocar de campanha:
 * quem estava na sala via os desafios de outra turma achando que eram os seus.
 *
 * - `?turma=<id>`  -> aquela turma, explicitamente
 * - `?turma=todas` -> o histórico inteiro, somado
 * - sem parâmetro  -> a turma ativa; só quando não existe turma ativa é que cai
 *                     no agregado (o caso de quem ainda não usa turmas)
 */
function resolverEscopo(param) {
  if (String(param ?? '') === 'todas') return { turma: null, escopo: 'todas' };

  const pedida = buscarTurma(param);
  if (pedida) return { turma: pedida, escopo: 'turma' };

  // O que a projeção mostra é escolha do facilitador, feita no painel.
  const exibicao = obterConfig('exibicao');
  if (exibicao === 'todas') return { turma: null, escopo: 'todas' };
  const escolhida = buscarTurma(exibicao);
  if (escolhida) return { turma: escolhida, escopo: 'escolhida' };

  const ativa = turmaAtiva();
  if (ativa) return { turma: ativa, escopo: 'ativa' };

  // Sem escolha e sem turma ativa, cai na última turma criada — nunca na soma
  // de campanhas. Somar turmas diferentes sem ninguém ter pedido foi o que
  // fazia a nuvem projetada mostrar a turma errada.
  const recente = turmaMaisRecente();
  if (recente) return { turma: recente, escopo: 'recente' };

  // Só quando não existe turma nenhuma: aí "tudo" é o único conjunto que há.
  return { turma: null, escopo: 'todas' };
}

app.get('/api/resultados', (req, res) => {
  const { turma, escopo } = resolverEscopo(req.query.turma);
  res.json({ ...resultados(turma ? turma.id : null), escopo });
});

/** QR code — da enquete, ou de uma turma específica quando `url` é passada. */
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

/* ---- cartilha ---- */

function cartilhaInfo() {
  if (!existsSync(CARTILHA_PDF)) return { existe: false };
  try {
    return { existe: true, ...JSON.parse(readFileSync(CARTILHA_META, 'utf8')) };
  } catch {
    return { existe: true };
  }
}

app.get('/api/cartilha/info', (_req, res) => res.json(cartilhaInfo()));

app.get('/cartilha', (_req, res) => {
  if (!existsSync(CARTILHA_PDF)) {
    return res.status(404).json({ erro: 'A cartilha ainda não foi publicada.' });
  }
  res
    .type('application/pdf')
    .setHeader('Content-Disposition', 'inline; filename="cartilha-oficina.pdf"')
    .setHeader('Cache-Control', 'public, max-age=300')
    .send(readFileSync(CARTILHA_PDF));
});

/* ------------------------------------------------------------------ *
 * Administração
 * ------------------------------------------------------------------ */

const ADMIN_USUARIO = process.env.ADMIN_USUARIO || 'admin';
const ADMIN_SENHA = process.env.ADMIN_SENHA || '';
const SESSAO_MS = 8 * 60 * 60 * 1000;
const sessoes = new Map();

/** Comparação em tempo constante, para não vazar a senha pelo tempo de resposta. */
function iguais(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function autenticado(req) {
  const token = req.get('x-admin-session');
  if (!token) return false;
  const s = sessoes.get(token);
  if (!s) return false;
  if (Date.now() > s.expira) {
    sessoes.delete(token);
    return false;
  }
  return true;
}

function exigirAdmin(req, res, next) {
  if (!autenticado(req)) {
    return res.status(401).json({ erro: 'Sessão de administração inválida ou expirada.' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  // Sem ADMIN_SENHA configurada o painel fica trancado, em vez de aberto com
  // uma senha padrão que estaria escrita no repositório público.
  if (!ADMIN_SENHA) {
    return res.status(503).json({ erro: 'Painel indisponível: ADMIN_SENHA não configurada.' });
  }
  const usuario = String(req.body?.usuario ?? '');
  const senha = String(req.body?.senha ?? '');
  if (!iguais(usuario, ADMIN_USUARIO) || !iguais(senha, ADMIN_SENHA)) {
    console.warn(`[admin] login falhou (usuario: "${usuario.slice(0, 40)}")`);
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }
  const token = randomBytes(24).toString('hex');
  sessoes.set(token, { expira: Date.now() + SESSAO_MS });
  res.json({ token, expira_em: new Date(Date.now() + SESSAO_MS).toISOString() });
});

app.post('/api/admin/logout', exigirAdmin, (req, res) => {
  sessoes.delete(req.get('x-admin-session'));
  res.json({ ok: true });
});

app.get('/api/admin/painel', exigirAdmin, (_req, res) => {
  const { turma, escopo } = resolverEscopo(null);
  res.json({
    turmas: listarTurmas(),
    sem_turma: respostasSemTurma(),
    geral: resultados(),
    cartilha: cartilhaInfo(),
    url_enquete: URL_ENQUETE,
    // O que as telas de projeção estão mostrando neste momento, e se isso veio
    // de uma escolha explícita ou de um padrão.
    exibicao: obterConfig('exibicao'),
    exibindo: { turma: turma ? { id: turma.id, nome: turma.nome } : null, escopo },
    gerado_em: new Date().toISOString(),
  });
});

/** Define o recorte que as telas de projeção mostram: um id de turma ou "todas". */
app.post('/api/admin/exibicao', exigirAdmin, (req, res) => {
  const valor = String(req.body?.valor ?? '').trim();
  if (valor !== 'todas' && !buscarTurma(valor)) {
    return res.status(400).json({ erro: 'Escolha uma turma válida ou "todas".' });
  }
  definirConfig('exibicao', valor);
  const { turma, escopo } = resolverEscopo(null);
  console.log(`[admin] exibicao: ${valor}`);
  res.json({ ok: true, exibicao: valor, exibindo: { turma, escopo } });
});

app.post('/api/admin/turmas', exigirAdmin, (req, res) => {
  const nome = String(req.body?.nome ?? '').trim();
  if (nome.length < 2) return res.status(400).json({ erro: 'Dê um nome à turma.' });

  const turma = criarTurma(nome);
  // Turma nova entra ativa: quem acabou de criar quer coletar nela, e esquecer
  // de ativar mandaria as respostas para a turma anterior sem ninguém notar.
  ativarTurma(turma.id);
  // E a projeção passa a mostrá-la. Criar turma e continuar vendo a anterior no
  // telão foi o problema relatado na oficina.
  definirConfig('exibicao', turma.id);
  res.status(201).json(listarTurmas());
});

app.post('/api/admin/turmas/:id/ativar', exigirAdmin, (req, res) => {
  if (!ativarTurma(req.params.id)) return res.status(404).json({ erro: 'Turma não encontrada.' });
  definirConfig('exibicao', req.params.id);
  res.json(listarTurmas());
});

app.post('/api/admin/turmas/desativar', exigirAdmin, (_req, res) => {
  desativarTodas();
  res.json(listarTurmas());
});

app.delete('/api/admin/turmas/:id', exigirAdmin, (req, res) => {
  if (!removerTurma(req.params.id)) return res.status(404).json({ erro: 'Turma não encontrada.' });
  // Sem isso a projeção ficaria apontando para uma turma que não existe mais e
  // cairia no padrão sem ninguém entender por quê.
  if (obterConfig('exibicao') === req.params.id) definirConfig('exibicao', null);
  res.json(listarTurmas());
});

app.get('/api/admin/resultados', exigirAdmin, (req, res) => {
  // Mesma regra das telas públicas, para o painel nunca mostrar um recorte
  // diferente do que está projetado na parede.
  const { turma, escopo } = resolverEscopo(req.query.turma);
  res.json({ ...resultados(turma ? turma.id : null), escopo });
});

/** Sobe ou substitui a cartilha. Corpo = bytes do PDF. */
app.put('/api/admin/cartilha', exigirAdmin, (req, res) => {
  const corpo = req.body;
  if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
    return res.status(400).json({ erro: 'Envie um arquivo PDF.' });
  }
  // Confere a assinatura do arquivo, e não só o Content-Type: o cabeçalho é
  // declarado pelo cliente, os primeiros bytes são o arquivo de verdade.
  if (corpo.subarray(0, 4).toString('latin1') !== '%PDF') {
    return res.status(400).json({ erro: 'O arquivo não é um PDF válido.' });
  }

  const meta = {
    nome: String(req.get('x-nome-arquivo') || 'cartilha.pdf').slice(0, 120),
    tamanho: corpo.length,
    enviado_em: new Date().toISOString(),
  };
  writeFileSync(CARTILHA_PDF, corpo);
  writeFileSync(CARTILHA_META, JSON.stringify(meta));
  console.log(`[admin] cartilha atualizada: ${meta.nome} (${meta.tamanho} bytes)`);
  res.json({ ok: true, existe: true, ...meta });
});

app.delete('/api/admin/cartilha', exigirAdmin, (_req, res) => {
  if (existsSync(CARTILHA_PDF)) unlinkSync(CARTILHA_PDF);
  if (existsSync(CARTILHA_META)) unlinkSync(CARTILHA_META);
  res.json({ ok: true, existe: false });
});

/**
 * Zera respostas. Aceita sessão do painel ou o cabeçalho x-admin-token — o
 * token serve para zerar por script, entre turmas, sem abrir o navegador.
 */
app.post('/api/admin/reset', (req, res) => {
  const porToken = process.env.ADMIN_TOKEN && req.get('x-admin-token') === process.env.ADMIN_TOKEN;
  if (!porToken && !autenticado(req)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  const turma = buscarTurma(req.query.turma ?? (req.body && req.body.turma));
  const apagados = limparTudo(turma ? turma.id : null);
  console.log(
    `[admin] reset: ${apagados.respostas} respostas (turma ${apagados.turma_id ?? 'todas'})`
  );
  res.json({ ok: true, ...apagados });
});

app.listen(PORTA, '0.0.0.0', () => {
  console.log(`[enquete-ppgdi] ouvindo na porta ${PORTA}`);
  console.log(`[enquete-ppgdi] enquete: ${URL_ENQUETE} | links: ${URL_LINKS}`);
  if (!ADMIN_SENHA) {
    console.warn('[enquete-ppgdi] ATENÇÃO: ADMIN_SENHA não configurada — painel trancado.');
  }
});
