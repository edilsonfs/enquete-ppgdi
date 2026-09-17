import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PERGUNTAS_FECHADAS } from './perguntas.js';

const DATA_DIR = process.env.DATA_DIR || './data';
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'enquete.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS respostas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    momento    TEXT NOT NULL,
    ia         TEXT NOT NULL,
    desafio    TEXT NOT NULL,
    criado_em  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_desafio ON respostas(desafio);

  CREATE TABLE IF NOT EXISTS turmas (
    id         TEXT PRIMARY KEY,
    nome       TEXT NOT NULL,
    ativa      INTEGER NOT NULL DEFAULT 0,
    criado_em  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    chave  TEXT PRIMARY KEY,
    valor  TEXT NOT NULL
  );
`);

/**
 * Migração idempotente: a tabela de respostas nasceu antes das turmas, e o
 * banco vive num volume que sobrevive ao deploy. Respostas anteriores ficam com
 * turma_id NULL e aparecem agrupadas como "sem turma" — apagar histórico para
 * simplificar a consulta seria pior do que exibir a lacuna.
 */
function garantirColuna(tabela, coluna, definicao) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  if (!colunas.includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${definicao}`);
}
garantirColuna('respostas', 'turma_id', 'turma_id TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_resp_turma ON respostas(turma_id);');

const agora = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Turmas
 * ------------------------------------------------------------------ */

export function criarTurma(nome) {
  const id = randomBytes(3).toString('hex'); // 6 caracteres, cabe num QR curto
  db.prepare('INSERT INTO turmas (id, nome, ativa, criado_em) VALUES (?, ?, 0, ?)').run(
    id,
    String(nome).trim().slice(0, 80),
    agora()
  );
  return buscarTurma(id);
}

export function buscarTurma(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM turmas WHERE id = ?').get(String(id)) ?? null;
}

/**
 * Só uma turma fica ativa por vez: é ela que recebe quem abre a enquete sem
 * nenhum parâmetro — o participante nunca escolhe turma, e é isso que mantém a
 * campanha transparente para quem responde.
 */
export function ativarTurma(id) {
  const turma = buscarTurma(id);
  if (!turma) return null;
  db.exec('UPDATE turmas SET ativa = 0');
  db.prepare('UPDATE turmas SET ativa = 1 WHERE id = ?').run(String(id));
  return buscarTurma(id);
}

export function desativarTodas() {
  db.exec('UPDATE turmas SET ativa = 0');
}

export function turmaAtiva() {
  return db.prepare('SELECT * FROM turmas WHERE ativa = 1 LIMIT 1').get() ?? null;
}

export function listarTurmas() {
  return db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM respostas r WHERE r.turma_id = t.id) AS respostas,
              (SELECT MAX(criado_em) FROM respostas r WHERE r.turma_id = t.id) AS ultima_em
         FROM turmas t
        ORDER BY t.ativa DESC, t.criado_em DESC`
    )
    .all()
    .map((t) => ({ ...t, ativa: !!t.ativa }));
}

/** Remove a turma da lista. As respostas dela ficam órfãs de propósito. */
export function removerTurma(id) {
  const turma = buscarTurma(id);
  if (!turma) return null;
  // As respostas não são apagadas junto: quem tira uma turma da lista quase
  // nunca quer destruir os dados já coletados. Elas passam a contar como "sem
  // turma" e continuam no total geral.
  db.prepare('UPDATE respostas SET turma_id = NULL WHERE turma_id = ?').run(String(id));
  db.prepare('DELETE FROM turmas WHERE id = ?').run(String(id));
  return turma;
}

/** A turma criada por último. Serve de rede quando nenhuma está ativa. */
export function turmaMaisRecente() {
  return db.prepare('SELECT * FROM turmas ORDER BY criado_em DESC LIMIT 1').get() ?? null;
}

/* ------------------------------------------------------------------ *
 * Configuração
 *
 * Hoje guarda uma chave só: `exibicao`, o recorte que as telas de projeção
 * mostram. É uma decisão do facilitador, e por isso mora no banco e não em
 * memória — precisa sobreviver ao redeploy e valer para todas as telas abertas,
 * que podem estar em máquinas diferentes.
 * ------------------------------------------------------------------ */

export function obterConfig(chave) {
  const linha = db.prepare('SELECT valor FROM config WHERE chave = ?').get(String(chave));
  return linha ? linha.valor : null;
}

export function definirConfig(chave, valor) {
  if (valor === null || valor === undefined) {
    db.prepare('DELETE FROM config WHERE chave = ?').run(String(chave));
    return null;
  }
  db.prepare(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  ).run(String(chave), String(valor));
  return String(valor);
}

/** Quantas respostas ficaram sem turma (anteriores ao recurso, ou órfãs). */
export function respostasSemTurma() {
  return db.prepare('SELECT COUNT(*) AS n FROM respostas WHERE turma_id IS NULL').get().n;
}

/* ------------------------------------------------------------------ *
 * Respostas
 * ------------------------------------------------------------------ */

export function salvarResposta({ momento, ia, desafio, turmaId }) {
  const info = db
    .prepare(
      'INSERT INTO respostas (momento, ia, desafio, turma_id, criado_em) VALUES (?, ?, ?, ?, ?)'
    )
    .run(momento, ia, desafio, turmaId ?? null, agora());
  return Number(info.lastInsertRowid);
}

/**
 * Tudo o que as telas de resultado precisam, numa chamada só.
 *
 * `turmaId` ausente agrega a base inteira; um id filtra aquela turma. As opções
 * sem nenhuma resposta vêm com zero, e não omitidas: um gráfico que esconde a
 * categoria vazia mente sobre a distribuição — quem olha não percebe que
 * ninguém escolheu aquela fase.
 */
export function resultados(turmaId) {
  const filtra = Boolean(turmaId);
  const onde = filtra ? 'WHERE turma_id = ?' : '';
  const args = filtra ? [String(turmaId)] : [];

  const total = db.prepare(`SELECT COUNT(*) AS n FROM respostas ${onde}`).get(...args).n;

  const graficos = PERGUNTAS_FECHADAS.map((p) => {
    const linhas = db
      .prepare(`SELECT ${p.id} AS opcao, COUNT(*) AS n FROM respostas ${onde} GROUP BY ${p.id}`)
      .all(...args);
    const contagem = new Map(linhas.map((l) => [l.opcao, l.n]));

    return {
      id: p.id,
      numero: p.numero,
      titulo: p.titulo,
      total,
      opcoes: p.opcoes.map((o) => {
        const n = contagem.get(o.id) ?? 0;
        return {
          id: o.id,
          rotulo: o.rotulo,
          n,
          pct: total ? Math.round((n / total) * 1000) / 10 : 0,
        };
      }),
    };
  });

  const palavras = db
    .prepare(
      `SELECT desafio AS palavra, COUNT(*) AS n FROM respostas ${onde}
        GROUP BY desafio ORDER BY n DESC, palavra ASC`
    )
    .all(...args);

  const turma = filtra ? buscarTurma(turmaId) : null;

  return {
    total,
    turma: turma ? { id: turma.id, nome: turma.nome } : null,
    graficos,
    palavras,
    // Serve ao polling das telas: muda sempre que chega resposta nova, então o
    // cliente sabe se precisa redesenhar.
    ultima_em: db.prepare(`SELECT MAX(criado_em) AS m FROM respostas ${onde}`).get(...args).m,
  };
}

/** Zera as respostas. Sem turma, zera tudo; com turma, só aquela. */
export function limparTudo(turmaId) {
  if (turmaId) {
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM respostas WHERE turma_id = ?')
      .get(String(turmaId));
    db.prepare('DELETE FROM respostas WHERE turma_id = ?').run(String(turmaId));
    return { respostas: n, turma_id: String(turmaId) };
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM respostas').get();
  db.exec('DELETE FROM respostas;');
  return { respostas: n, turma_id: null };
}

export default db;
