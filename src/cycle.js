'use strict';

/**
 * cycle.js — Execucao unica (CLI) de um ciclo completo.
 *
 * Uso:
 *   node src/cycle.js                 -> descobre, valida e publica no GitHub
 *   node src/cycle.js --check         -> apenas descobre e valida (nao publica)
 *   node src/cycle.js --no-publish    -> igual ao --check (alias)
 *
 * Saida de codigo:
 *   0 = sucesso
 *   1 = erro generico
 *   2 = ciclo concluido, mas existem links invalidos nao publicados
 *
 * Ideal para o Agendador de Tarefas do Windows quando nao se deseja
 * manter o servidor da interface rodando.
 */

const path = require('node:path');
const { config, PROJECT_ROOT } = require('./config');
const logger = require('./logger');
const { runCycle, DATA_DIR } = require('./pipeline');
const { loadState } = require('./state');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check') || args.includes('--no-publish');

logger.init({ dataDir: DATA_DIR, level: config.logLevel });

runCycle({ publish: !checkOnly, source: 'cli' })
  .then((summary) => {
    const state = loadState(DATA_DIR);
    console.log('---------------------------------------------------------');
    console.log(`Encontradas : ${summary.discovered}`);
    console.log(`Ativas      : ${summary.active}`);
    console.log(`Invalidas   : ${summary.invalid}`);
    console.log(`Novas       : ${summary.added.length}`);
    console.log(`Removidas   : ${summary.removed.length}`);
    if (summary.published === true) {
      console.log(`Publicado   : sim (commit ${String(summary.commitSha).slice(0, 7)})`);
    } else if (summary.published === false) {
      console.log(`Publicado   : sem mudancas`);
    } else {
      console.log('Publicado   : (verificacao apenas)');
    }
    console.log(`Playlist    : ${config.publicPlaylistUrl}`);
    console.log('---------------------------------------------------------');
    if (summary.invalid > 0) process.exit(2);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`ERRO: ${err.message}`);
    process.exit(1);
  });