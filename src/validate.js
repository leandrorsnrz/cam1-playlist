'use strict';

/**
 * validate.js — Validacao leve dos manifestos HLS.
 *
 * Para cada link .m3u8 faz uma requisicao com timeout curto, le o primeiro
 * bloco de dados e confirma que o conteudo comeca com "#EXTM3U".
 * Nao baixa o video: apenas verifica se o manifesto esta servido.
 *
 * Executa com concorrencia limitada e uma segunda passada para os que
 * falharam (falhas temporarias de rede sao comuns em CDNs).
 */

const { UA } = require('./cam4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Valida um m3u8 individual.
 * Retorna null se valido, ou uma mensagem de erro.
 * fetchImpl e injetavel para testes.
 */
async function validateOne(room, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(room.url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Consome o corpo para liberar a conexao antes de retornar.
      try { await res.arrayBuffer(); } catch { /* ignora */ }
      return `HTTP ${res.status} ${res.statusText || ''}`.trim();
    }
    // Le apenas o primeiro chunk do manifesto.
    const reader = res.body.getReader();
    let head = '';
    try {
      const { value } = await reader.read();
      if (value) head = Buffer.from(value).toString('utf8');
    } finally {
      try { await reader.cancel(); } catch { /* ja fechado */ }
    }
    const trimmed = head.replace(/^\uFEFF/, '').trimStart();
    if (trimmed.startsWith('#EXTM3U')) return null;
    return 'resposta nao parece um manifesto HLS';
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? `timeout apos ${timeoutMs} ms` : e.message;
    return `erro HTTP: ${reason}`;
  }
}

/** Pool assincrono com concorrencia limitada. */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Valida varias salas em paralelo.
 * Retorna { ok: Room[], failed: Array<{ room, error }> }.
 */
async function validateRooms(rooms, opts = {}, log = () => {}) {
  const {
    concurrency = 8,
    tries = 2,
    timeoutMs = 15000,
    fetchImpl = fetch,
  } = opts;

  if (!rooms.length) return { ok: [], failed: [] };

  let failed = [];
  let ok = [];

  for (let attempt = 0; attempt < tries; attempt++) {
    // A partir da 2a tentativa, so as salas que falharam sao revalidadas;
    // as ja aprovadas em tentativas anteriores sao preservadas em ok.
    const pending = attempt === 0 ? rooms : failed.map((f) => f.room);
    if (attempt > 0) {
      log('info', `${failed.length} links falharam; repetindo validacao (tentativa ${attempt + 1}/${tries})...`);
      await sleep(1500);
    }
    const errors = await runPool(pending, concurrency, (room) => validateOne(room, { timeoutMs, fetchImpl }));
    const retriedOk = [];
    const retriedFailed = [];
    for (let i = 0; i < pending.length; i++) {
      const err = errors[i];
      if (err === null) retriedOk.push(pending[i]);
      else retriedFailed.push({ room: pending[i], error: err });
    }
    ok = attempt === 0 ? retriedOk : ok.concat(retriedOk);
    failed = retriedFailed;
    if (!failed.length) break;
  }

  return { ok, failed };
}

module.exports = { validateOne, validateRooms, runPool };