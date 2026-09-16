import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
`);

const agora = () => new Date().toISOString();

export function salvarResposta({ momento, ia, desafio }) {
  const info = db
    .prepare('INSERT INTO respostas (momento, ia, desafio, criado_em) VALUES (?, ?, ?, ?)')
    .run(momento, ia, desafio, agora());
  return Number(info.lastInsertRowid);
}

/**
 * Tudo o que a tela de resultado precisa, numa chamada só.
 *
 * As opções sem nenhuma resposta vêm com zero, e não omitidas: um gráfico que
 * esconde a categoria vazia mente sobre a distribuição — quem olha não percebe
 * que ninguém escolheu aquela fase.
 */
export function resultados() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM respostas').get().n;

  const graficos = PERGUNTAS_FECHADAS.map((p) => {
    const linhas = db
      .prepare(`SELECT ${p.id} AS opcao, COUNT(*) AS n FROM respostas GROUP BY ${p.id}`)
      .all();
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
      'SELECT desafio AS palavra, COUNT(*) AS n FROM respostas GROUP BY desafio ORDER BY n DESC, palavra ASC'
    )
    .all();

  return {
    total,
    graficos,
    palavras,
    // Serve ao polling da tela de resultado: muda sempre que chega resposta
    // nova, então o cliente sabe se precisa redesenhar.
    ultima_em: db.prepare('SELECT MAX(criado_em) AS m FROM respostas').get().m,
  };
}

/** Zera a enquete — para reaproveitar entre turmas. */
export function limparTudo() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM respostas').get();
  db.exec('DELETE FROM respostas;');
  return { respostas: n };
}

export default db;
