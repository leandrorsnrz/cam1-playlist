'use strict';

/**
 * Testes do modulo de descoberta CAM4 (API GraphQL e fallback HTML)
 * com fetch simulado. Executar: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  gqlBroadcasts,
  normalizeRoom,
  listRoomsGql,
  listRoomsHtml,
  extractApolloStateJson,
} = require('../src/cam4');

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const gqlItem = {
  id: '1',
  username: 'Usuaria.Exemplo',
  country: 'BR',
  viewers: 42,
  gender: 'female',
  broadcastType: 'LIVE',
  showType: 'PUBLIC_SHOW',
  profileImageURL: 'https://img.example/perfil.jpg',
  preview: {
    sourceType: 'HLS',
    src: 'https://cam4-hls.example/live/index.m3u8',
    poster: 'https://snapshots.example/thumb.jpg',
  },
};

test('gqlBroadcasts envia query e variaveis corretas', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return jsonRes(200, { data: { broadcasts: { total: 1, items: [gqlItem] } } });
  };
  const { items, total } = await gqlBroadcasts('female', 10, 0, { fetchImpl });
  assert.strictEqual(captured.url, 'https://www.cam4.com/graph');
  assert.strictEqual(captured.body.variables.input.gender, 'female');
  assert.strictEqual(captured.body.variables.input.cursor.first, 10);
  assert.ok(captured.body.query.includes('broadcasts(input: $input)'));
  assert.strictEqual(total, 1);
  assert.strictEqual(items.length, 1);
});

test('gqlBroadcasts propaga erro GraphQL', async () => {
  const fetchImpl = async () => jsonRes(200, { errors: [{ message: 'genero invalido' }] });
  await assert.rejects(() => gqlBroadcasts('trans', 10, 0, { fetchImpl }), /genero invalido/);
});

test('normalizeRoom extrai campos e descarta itens inuteis', () => {
  const room = normalizeRoom(gqlItem, 'female');
  assert.strictEqual(room.name, 'Usuaria.Exemplo');
  assert.strictEqual(room.url, 'https://cam4-hls.example/live/index.m3u8');
  assert.strictEqual(room.viewers, 42);
  assert.strictEqual(room.country, 'BR');
  assert.strictEqual(room.showType, 'PUBLIC_SHOW');
  assert.strictEqual(room.logo, 'https://snapshots.example/thumb.jpg');
  assert.strictEqual(normalizeRoom({ preview: { src: 'x' } }), null, 'sem username');
  assert.strictEqual(normalizeRoom({ username: 'x', preview: {} }), null, 'sem src');
  assert.strictEqual(normalizeRoom(null), null);
});

test('listRoomsGql pagina, deduplica e para no limite', async () => {
  const pages = [
    { data: { broadcasts: { total: 4, items: [gqlItem, { ...gqlItem, username: 'Outra', viewers: 10 }] } } },
    { data: { broadcasts: { total: 4, items: [{ ...gqlItem, username: 'Terceira' }, { ...gqlItem, username: 'Usuaria.Exemplo' }] } } }, // 1 duplicada
  ];
  let call = 0;
  const fetchImpl = async () => jsonRes(200, pages[call++] ?? { data: { broadcasts: { total: 4, items: [] } } });
  const { rooms } = await listRoomsGql(
    ['female'],
    { pageSize: 2, maxPages: 5, maxRooms: 0, fetchImpl }
  );
  assert.strictEqual(rooms.length, 3, 'esperadas 3 salas unicas');
  assert.ok(rooms.some((r) => r.name === 'Usuaria.Exemplo'));
});

test('listRoomsGql respeita maxRooms', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    return jsonRes(200, {
      data: { broadcasts: { total: 100, items: [1, 2, 3, 4, 5].map((i) => ({ ...gqlItem, username: `User${i}-${call}` })) } },
    });
  };
  const { rooms } = await listRoomsGql(['female'], { pageSize: 5, maxPages: 10, maxRooms: 7, fetchImpl });
  assert.ok(rooms.length <= 7);
});

test('fallback HTML extrai BroadcastItem do apolloState', async () => {
  const state = {
    ROOT_QUERY: { __typename: 'Query' },
    'BroadcastItem:1': { __typename: 'BroadcastItem', ...gqlItem },
    'BroadcastItem:2': { __typename: 'BroadcastItem', ...gqlItem, username: 'OutraHTML' },
    'Other:3': { __typename: 'Other' },
  };
  // Terminadores observados: ";})();" (sintetico) e "; }());" (HTML real do CAM4)
  const html = `<html><script>window.apolloState = ${JSON.stringify(state)};})();</script></html>`;
  const htmlReal = `<html><script>window.apolloState = ${JSON.stringify(state)}; }());</script></html>`;
  assert.ok(extractApolloStateJson(html), 'extrator deve casar com o formato embutido');
  assert.ok(extractApolloStateJson(htmlReal), 'extrator deve casar com o formato real do CAM4');
  assert.strictEqual(extractApolloStateJson(html), JSON.stringify(state));
  assert.strictEqual(extractApolloStateJson(htmlReal), JSON.stringify(state));
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith('/female'));
    return { ok: true, status: 200, text: async () => html };
  };
  const rooms = await listRoomsHtml(['female'], { fetchImpl });
  assert.strictEqual(rooms.length, 2);
  assert.ok(rooms.some((r) => r.name === 'OutraHTML'));
});