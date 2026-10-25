'use strict';

/**
 * index.js — Servidor HTTP: interface de gerenciamento + API local.
 *
 * Endpoints:
 *   GET  /                    -> interface HTML
 *   GET  /api/status          -> estado atual (contadores, GitHub, agendador)
 *   POST /api/run             -> ciclo completo com publicacao no GitHub
 *   POST /api/check           -> apenas descoberta + validacao (sem publicar)
 *   GET  /api/logs?level=info -> ultimas entradas de log
 *   GET  /api/playlist        -> playlist gerada localmente (data/cam1.m3u)
 *   POST /api/settings        -> altera o intervalo automatico em runtime
 *   POST /api/scheduler/pause -> pausa o agendador automatico
 *   POST /api/scheduler/resume-> retoma o agendador automatico
 *
 * O token do GitHub NUNCA e enviado ao navegador.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { config, PROJECT_ROOT, loadRuntimeOverrides, saveRuntimeOverrides, publicSummary } = require('./config');
const logger = require('./logger');
const { runCycle, isBusy, DATA_DIR } = require('./pipeline');
const { Scheduler } = require('./scheduler');
const { loadState, saveState, defaultState } = require('./state');

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const LOCAL_M3U = path.join(DATA_DIR, 'cam1.m3u');

// ------------------------------------------------------------------ boot --
logger.init({ dataDir: DATA_DIR, level: config.logLevel });
loadRuntimeOverrides(DATA_DIR);

// Garante um estado inicial valido
if (!fs.existsSync(path.join(DATA_DIR, 'state.json'))) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  saveState(DATA_DIR, defaultState());
}

const scheduler = new Scheduler({
  runFn: (source) => runCycle({ publish: true, source }),
  getBusy: isBusy,
});

// -------------------------------------------------------------- helpers --
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('corpo muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- server --
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  const p = url.pathname;

  try {
    if (p === '/api/status' && req.method === 'GET') {
      const state = loadState(DATA_DIR);
      return sendJson(res, 200, {
        busy: isBusy(),
        config: publicSummary(),
        scheduler: scheduler.status(),
        state,
        serverTime: new Date().toISOString(),
      });
    }

    if (p === '/api/run' && req.method === 'POST') {
      if (isBusy()) {
        return sendJson(res, 409, { error: 'Um ciclo ja esta em execucao. Aguarde.' });
      }
      // Responde imediatamente; o ciclo roda em background e a interface
      // acompanha via /api/status e /api/logs.
      sendJson(res, 202, { started: true });
      runCycle({ publish: true, source: 'manual' }).catch(() => {});
      return;
    }

    if (p === '/api/check' && req.method === 'POST') {
      if (isBusy()) {
        return sendJson(res, 409, { error: 'Um ciclo ja esta em execucao. Aguarde.' });
      }
      sendJson(res, 202, { started: true });
      runCycle({ publish: false, source: 'manual-check' }).catch(() => {});
      return;
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const level = url.searchParams.get('level') || 'debug';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 1000);
      return sendJson(res, 200, { logs: logger.getRecent(limit, level) });
    }

    if (p === '/api/playlist' && req.method === 'GET') {
      if (!fs.existsSync(LOCAL_M3U)) {
        return sendJson(res, 404, { error: 'Playlist ainda nao foi gerada.' });
      }
      const content = fs.readFileSync(LOCAL_M3U, 'utf8');
      return sendJson(res, 200, { content });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!Number.isFinite(Number(body.updateIntervalMinutes))) {
        return sendJson(res, 400, { error: 'Informe updateIntervalMinutes (numero de minutos >= 1).' });
      }
      const minutes = Math.floor(Number(body.updateIntervalMinutes));
      scheduler.setIntervalMinutes(minutes);
      saveRuntimeOverrides(DATA_DIR, { updateIntervalMinutes: minutes });
      return sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
    }

    if (p === '/api/scheduler/pause' && req.method === 'POST') {
      scheduler.pause();
      return sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
    }

    if (p === '/api/scheduler/resume' && req.method === 'POST') {
      scheduler.resume();
      return sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
    }

    if (p.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Endpoint desconhecido' });
    }

    serveStatic(res, p);
  } catch (err) {
    logger.error(`Erro no servidor HTTP (${p}): ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(config.port, () => {
  logger.info(`Interface disponivel em http://localhost:${config.port}`);
  logger.info(`Playlist publicada: ${config.publicPlaylistUrl}`);
  if (!config.githubToken) {
    logger.warn('GITHUB_TOKEN nao configurado: os ciclos gerarao a playlist localmente, mas nao publicarao no GitHub.');
  }
  scheduler.start();
});

// Encerramento limpo
function shutdown(signal) {
  logger.info(`Recebido ${signal}; encerrando servidor e agendador...`);
  scheduler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));