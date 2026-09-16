/**
 * Catálogo das perguntas. É a única fonte: o formulário, a validação do POST, os
 * gráficos e a tabela de dados saem todos daqui. Acrescentar uma opção é mexer
 * num lugar só.
 *
 * As duas primeiras perguntas reproduzem o formulário original da enquete; a
 * terceira é aberta, de uma palavra, e alimenta a nuvem.
 *
 * A ordem das opções é significativa — as duas escalas são ordinais, do menos
 * avançado ao mais avançado. É essa ordem que justifica a rampa de um só tom nos
 * gráficos, em vez de cores categóricas.
 */

export const PERGUNTAS = [
  {
    id: 'momento',
    numero: 1,
    titulo: 'Em que momento da sua pesquisa você está?',
    tipo: 'unica',
    opcoes: [
      { id: 'nao_comecei', rotulo: 'Ainda não comecei' },
      { id: 'tema_sem_problema', rotulo: 'Tenho o tema, mas falta definir o problema de pesquisa' },
      { id: 'levantando_referencias', rotulo: 'Tema e problema definidos, levantando referências' },
      { id: 'escrevendo', rotulo: 'Estou escrevendo a pesquisa' },
      { id: 'finalizando', rotulo: 'Estou finalizando/revisando' },
    ],
  },
  {
    id: 'ia',
    numero: 2,
    titulo: 'Como você utiliza a Inteligência Artificial na sua pesquisa?',
    tipo: 'unica',
    opcoes: [
      { id: 'nunca', rotulo: 'Nunca utilizo' },
      { id: 'as_vezes', rotulo: 'Utilizo algumas vezes' },
      { id: 'frequentemente', rotulo: 'Utilizo frequentemente' },
      { id: 'quer_aprender', rotulo: 'Ainda não utilizo, mas gostaria de aprender' },
    ],
  },
  {
    id: 'desafio',
    numero: 3,
    titulo: 'Qual é o maior desafio que você enfrenta em relação ao seu projeto de pesquisa?',
    ajuda: 'Uma palavra.',
    tipo: 'palavra',
  },
];

export const PERGUNTAS_FECHADAS = PERGUNTAS.filter((p) => p.tipo === 'unica');

/** Valida a resposta e devolve só o que será gravado. Lança se inválida. */
export function validarResposta(corpo) {
  const limpa = {};

  for (const p of PERGUNTAS_FECHADAS) {
    const valor = String(corpo?.[p.id] ?? '').trim();
    if (!valor) throw new Error(`Responda a pergunta ${p.numero}.`);
    if (!p.opcoes.some((o) => o.id === valor)) {
      throw new Error(`Opção inválida na pergunta ${p.numero}.`);
    }
    limpa[p.id] = valor;
  }

  limpa.desafio = normalizarPalavra(corpo?.desafio);
  if (!limpa.desafio) throw new Error('Escreva uma palavra para o maior desafio.');

  return limpa;
}

/**
 * Palavras que não podem virar o rótulo da nuvem: sozinhas não dizem qual é o
 * desafio.
 */
const VAZIAS = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com', 'sem', 'e', 'ou', 'que',
  'meu', 'minha', 'muito', 'muita', 'pouco', 'pouca', 'falta', 'ter', 'tenho',
  'nao', 'ao', 'aos', 'se', 'ser', 'mais', 'menos', 'the',
]);

/**
 * Reduz a resposta aberta a UMA palavra comparável.
 *
 * Quem responde "Falta de tempo" e quem responde "tempo" está dizendo a mesma
 * coisa, e na nuvem precisam virar a mesma palavra — senão ela vira uma lista de
 * frases únicas de frequência 1, que não informa nada. Daí: minúsculas, sem
 * acento, sem pontuação, e fica a primeira palavra com significado.
 */
export function normalizarPalavra(bruto) {
  const texto = String(bruto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .trim();

  if (!texto) return '';

  const palavras = texto.split(/\s+/).filter(Boolean);
  // Se sobrar só palavra vazia, devolve a primeira mesmo assim — melhor manter a
  // resposta de quem escreveu algo curto do que descartá-la.
  const significativa = palavras.find((p) => p.length >= 3 && !VAZIAS.has(p));
  return (significativa ?? palavras[0]).slice(0, 24);
}
