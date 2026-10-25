'use strict';

/**
 * cam4.js — Descoberta das transmissoes ao vivo do CAM4.
 *
 * Mecanismos publicos utilizados (nenhum acesso autenticado ou protegido
 * e contornado; o proprio site expoe estes dados aos visitantes):
 *
 *  1. API GraphQL publica usada pelo proprio front-end do site:
 *       POST https://www.cam4.com/graph  (query "broadcasts")
 *     Cada item ja traz o manifesto HLS publico em preview.src.
 *
 *  2. Reserva (fallback): o HTML do diretorio publico (/female, /male,
 *     /transgender) embute o cache GraphQL "window.apolloState" com as
 *     salas da primeira pagina (~60 salas).
 *
 * Observado empiricamente: o genero "transgender" e aceito; variantes
 * como "trans"/"shemale" retornam erro da API.
 */

const { config } = require('./config');

const BASE_URL = 'https://www.cam4.com';
const GRAPH_URL = `${BASE_URL}/graph`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GRAPH_QUERY = `
query ($input: BroadcastsInput!) {
  broadcasts(input: $input) {
    total
    items {
      id
      username
      country
      viewers
      gender
      broadcastType
      showType
      profileImageURL
      preview {
        sourceType
        src
        poster
      }
    }
  }
}
`.trim();

// Extrai o JSON de "window.apolloState = {...}" do HTML do diretorio publico.
// O terminador varia entre builds (ex.: "; }());" ou ";})();"), entao em vez de
// regex delimitado pelo final, localizamos a chave de abertura e contamos chaves,
// respeitando strings e escapes do JSON. Isso casou no HTML real de
// https://www.cam4.com/female (bloco de ~267 KB encerrado por "}}; }());").
function extractApolloStateJson(html) {
  const marker = html.indexOf('window.apolloState');
  if (marker === -1) return null;
  let i = html.indexOf('=', marker);
  if (i === -1) return null;
  i++;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') return null;
  const objStart = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(objStart, i + 1);
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma pagina da API de broadcasts. Retorna { items, total }.
 * fetchImpl e injetavel para testes.
 */
async function gqlBroadcasts(gender, first, offset, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const variables = {
    input: { cursor: { first, offset }, filters: [], orderBy: 'trending' },
  };
  if (gender) variables.input.gender = gender;

  let res;
  try {
    res = await fetchImpl(GRAPH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
      },
      body: JSON.stringify({ query: GRAPH_QUERY, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`falha de rede na API GraphQL: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`API GraphQL respondeu HTTP ${res.status}`);
  }
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(`GraphQL: ${payload.errors[0].message || 'erro desconhecido'}`);
  }
  const b = payload && payload.data && payload.data.broadcasts;
  if (!b) throw new Error('GraphQL: resposta sem data.broadcasts');
  return { items: b.items || [], total: b.total || 0 };
}

/**
 * Converte um item da API no formato interno.
 * Retorna null se o item nao tiver usuario ou manifesto utilizavel.
 */
function normalizeRoom(item, genderHint = '') {
  if (!item || typeof item !== 'object') return null;
  const username = String(item.username || '').trim();
  if (!username) return null;
  const prev = item.preview || {};
  const src = String(prev.src || '').trim();
  if (!src) return null;
  return {
    name: username,
    url: src,
    gender: String(item.gender || genderHint || 'unknown').toLowerCase(),
    viewers: Number(item.viewers) || 0,
    country: String(item.country || '').trim().toUpperCase() || '--',
    showType: String(item.showType || '').trim(),
    logo: String(prev.poster || item.profileImageURL || '').trim(),
  };
}

/**
 * Lista salas ao vivo paginando a API GraphQL, por genero.
 * - Retenta cada pagina ate 3 vezes (backoff curto).
 * - Pausa 400 ms entre paginas para respeitar o servico.
 * - Para cedo quando atinge maxRooms (0 = ilimitado).
 */
async function listRoomsGql(genders, opts = {}, log = () => {}) {
  const {
    pageSize = config.cam4PageSize,
    maxPages = config.cam4MaxPages,
    maxRooms = config.cam4MaxRooms,
    fetchImpl = fetch,
  } = opts;

  const rooms = [];
  const seen = new Set();
  let apiFailures = 0;

  for (const gender of genders) {
    if (maxRooms && rooms.length >= maxRooms) break;
    let offset = 0;
    let fetchedTotal = null;

    for (let page = 0; page < maxPages; page++) {
      let items = null;
      let total = 0;
      let lastErr = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await gqlBroadcasts(gender, pageSize, offset, { fetchImpl });
          items = r.items;
          total = r.total;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) {
            const wait = 1500 * (attempt + 1) + Math.floor(Math.random() * 800);
            log('debug', `CAM4 retry ${attempt + 1}/3 (${gender}, offset=${offset}): ${e.message}`);
            await sleep(wait);
          }
        }
      }

      if (!items) {
        apiFailures++;
        log('warn', `CAM4: pagina ${gender} offset=${offset} falhou apos 3 tentativas: ${lastErr && lastErr.message}`);
        break;
      }

      if (fetchedTotal === null) fetchedTotal = total;
      if (!items.length) break;

      let novos = 0;
      for (const it of items) {
        const room = normalizeRoom(it, gender);
        if (room && !seen.has(room.name.toLowerCase())) {
          seen.add(room.name.toLowerCase());
          rooms.push(room);
          novos++;
        }
      }

      offset += items.length;
      log(
        'debug',
        `CAM4: ${gender} offset=${offset - items.length} -> ${items.length} itens (${novos} novos), total API=${fetchedTotal}`
      );

      if (maxRooms && rooms.length >= maxRooms) break;
      if (items.length < pageSize || offset >= fetchedTotal) break;
      await sleep(400); // educado com a API entre paginas
    }
  }

  if (maxRooms && rooms.length > maxRooms) rooms.length = maxRooms;
  return { rooms, apiFailures };
}

/** Reserva: extrai BroadcastItem do apolloState embutido no HTML publico. */
async function listRoomsHtml(genders, { timeoutMs = 30000, fetchImpl = fetch } = {}, log = () => {}) {
  const rooms = [];
  const seen = new Set();

  for (const gender of genders) {
    try {
      const res = await fetchImpl(`${BASE_URL}/${gender}`, {
        headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log('warn', `CAM4 HTML fallback (${gender}): HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const stateJson = extractApolloStateJson(html);
      if (!stateJson) {
        log('warn', `CAM4 HTML fallback (${gender}): apolloState nao encontrado no HTML`);
        continue;
      }
      let state;
      try {
        state = JSON.parse(stateJson);
      } catch {
        log('warn', `CAM4 HTML fallback (${gender}): apolloState nao e JSON valido`);
        continue;
      }
      for (const key of Object.keys(state)) {
        const it = state[key];
        if (!it || typeof it !== 'object' || it.__typename !== 'BroadcastItem') continue;
        const room = normalizeRoom(it, gender);
        if (room && !seen.has(room.name.toLowerCase())) {
          seen.add(room.name.toLowerCase());
          rooms.push(room);
        }
      }
    } catch (e) {
      log('warn', `CAM4 HTML fallback (${gender}): ${e.message}`);
    }
  }
  return rooms;
}

/**
 * Descoberta completa: GraphQL com fallback para HTML.
 * Retorna { rooms, viaGql, viaHtml, apiFailures }.
 */
async function discoverRooms(log = () => {}) {
  log('info', `Consultando salas ao vivo do CAM4 (${config.genders.join(', ')})...`);
  const gql = await listRoomsGql(config.genders, {}, log);
  let rooms = gql.rooms;

  if (!rooms.length) {
    log('warn', 'API GraphQL nao retornou salas; tentando fallback do diretorio HTML...');
    rooms = await listRoomsHtml(config.genders, {}, log);
    if (rooms.length) {
      log('info', `Fallback HTML: ${rooms.length} salas recuperadas`);
    }
  }

  return { rooms, viaGql: gql.rooms.length > 0, viaHtml: rooms.length > 0 && !gql.rooms.length, apiFailures: gql.apiFailures };
}

module.exports = {
  BASE_URL,
  GRAPH_URL,
  GRAPH_QUERY,
  UA,
  extractApolloStateJson,
  gqlBroadcasts,
  normalizeRoom,
  listRoomsGql,
  listRoomsHtml,
  discoverRooms,
};