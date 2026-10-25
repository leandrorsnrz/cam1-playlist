'use strict';

/**
 * state.js — Persistencia do estado do sistema em data/state.json.
 *
 * Guarda: resultado da ultima execucao, contadores, historico de execucoes
 * e publicacoes, e o ultimo SHA conhecido do arquivo no GitHub.
 */

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_LIMIT = 30;

function stateFile(dataDir) {
  return path.join(dataDir, 'state.json');
}

function defaultState() {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    stats: { discovered: 0, active: 0, invalid: 0 },
    lastAdded: [],
    lastRemoved: [],
    github: {
      lastPublishAt: null,
      lastCommitSha: null,
      lastFileSha: null,
      lastVerifiedRaw: false,
      status: 'unknown', // unknown | ok | error | not-configured
      lastMessage: '',
    },
    runHistory: [],
    publishHistory: [],
  };
}

function loadState(dataDir) {
  const file = stateFile(dataDir);
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...defaultState(), ...raw };
    }
  } catch {
    // Estado corrompido: recomeca com estado padrao (log acontece fora).
  }
  return defaultState();
}

function saveState(dataDir, state) {
  const file = stateFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  // Gravacao atomica: escreve em .tmp e renomeia, evitando JSON parcial.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function pushHistory(list, entry, limit = HISTORY_LIMIT) {
  const next = Array.isArray(list) ? list.slice() : [];
  next.unshift(entry);
  if (next.length > limit) next.length = limit;
  return next;
}

module.exports = { defaultState, loadState, saveState, pushHistory, HISTORY_LIMIT };