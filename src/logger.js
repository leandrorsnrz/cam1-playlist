'use strict';

/**
 * logger.js — Registro de logs em memoria (para a interface) e em arquivo.
 *
 * - Ring buffer em memoria com as ultimas entradas (consultado via API HTTP).
 * - Arquivo de log em data/logs/cam1.log com rotacao simples por tamanho.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB antes de rotacionar

const ring = [];
let logDir = null;
let logFile = null;
let minLevel = 'info';

function init({ dataDir, level }) {
  logDir = path.join(dataDir, 'logs');
  logFile = path.join(logDir, 'cam1.log');
  fs.mkdirSync(logDir, { recursive: true });
  minLevel = LEVELS[level] ? level : 'info';
}

function writeToFile(entry) {
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile)) {
      const size = fs.statSync(logFile).size;
      if (size > MAX_LOG_BYTES) {
        const old = logFile + '.1';
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(logFile, old);
      }
    }
    fs.appendFileSync(logFile, `${entry.ts} [${entry.level.toUpperCase()}] ${entry.msg}\n`, 'utf8');
  } catch {
    // Falha de disco nunca deve derrubar o processo por causa de log.
  }
}

function log(level, msg, extra) {
  if (!LEVELS[level]) level = 'info';
  if (LEVELS[level] < LEVELS[minLevel]) return null;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : String(msg),
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  writeToFile(entry);
  return entry;
}

const logger = {
  init,
  debug: (m, e) => log('debug', m, e),
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),

  /** Ultimas entradas, opcionalmente filtradas por nivel minimo. */
  getRecent(limit = 200, minLevelName = 'debug') {
    const min = LEVELS[minLevelName] ?? 10;
    return ring.filter((e) => LEVELS[e.level] >= min).slice(-limit);
  },
};

module.exports = logger;