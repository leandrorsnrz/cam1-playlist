'use strict';

/**
 * Testes da geracao M3U (node:test nativo — sem dependencias).
 * Executar: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildM3U, dedupeRooms, sortRooms, countEntries, genderLabel } = require('../src/m3u');

const rooms = [
  { name: 'AnaLive', url: 'https://cdn.example/a.m3u8', gender: 'female', viewers: 50, logo: 'https://img.example/a.jpg' },
  { name: 'BrunoShow', url: 'https://cdn.example/b.m3u8', gender: 'male', viewers: 10, logo: '' },
  { name: 'CrisStar', url: 'https://cdn.example/c.m3u8', gender: 'transgender', viewers: 7, logo: 'https://img.example/c.jpg' },
];

test('cabecalho #EXTM3U presente', () => {
  const m3u = buildM3U(rooms);
  assert.ok(m3u.startsWith('#EXTM3U\n'));
});

test('cada sala gera um par #EXTINF + URL', () => {
  const m3u = buildM3U(rooms);
  assert.strictEqual(countEntries(m3u), 3);
  assert.ok(m3u.includes('https://cdn.example/a.m3u8'));
  assert.ok(m3u.includes('https://cdn.example/b.m3u8'));
  assert.ok(m3u.includes('https://cdn.example/c.m3u8'));
});

test('EXTINF contem metadados tvg e group-title', () => {
  const m3u = buildM3U(rooms);
  const line = m3u.split('\n').find((l) => l.startsWith('#EXTINF') && l.includes('AnaLive'));
  assert.ok(line, 'linha EXTINF da AnaLive nao encontrada');
  assert.ok(line.includes('tvg-name="AnaLive"'));
  assert.ok(line.includes('tvg-logo="https://img.example/a.jpg"'));
  assert.ok(line.includes('group-title="Cam4 Female"'));
  assert.ok(line.includes(',Cam4 AnaLive [Female] (50 viewers)'));
});

test('deduplicacao por nome mantendo maior audiencia', () => {
  const dup = [
    ...rooms,
    { name: 'analive', url: 'https://cdn.example/a2.m3u8', gender: 'female', viewers: 99 },
  ];
  const dedup = dedupeRooms(dup);
  assert.strictEqual(dedup.length, 3);
  const ana = dedup.find((r) => r.name.toLowerCase() === 'analive');
  assert.strictEqual(ana.url, 'https://cdn.example/a2.m3u8'); // viewers 99 > 50
  assert.strictEqual(ana.viewers, 99);
});

test('salas sem URL ou sem nome sao descartadas', () => {
  const dirty = [
    { name: 'SemUrl', url: '', gender: 'female', viewers: 1 },
    { name: '', url: 'https://cdn.example/x.m3u8', gender: 'female', viewers: 2 },
    ...rooms,
  ];
  const m3u = buildM3U(dirty);
  assert.strictEqual(countEntries(m3u), 3);
});

test('ordenacao estavel: genero -> viewers desc -> nome', () => {
  const sorted = sortRooms(rooms, ['female', 'male', 'transgender']);
  assert.deepStrictEqual(sorted.map((r) => r.name), ['AnaLive', 'BrunoShow', 'CrisStar']);
});

test('geracao e deterministica (mesma entrada -> mesma saida)', () => {
  const a = buildM3U(rooms.slice().reverse());
  const b = buildM3U(rooms);
  assert.strictEqual(a, b);
});

test('lista vazia gera apenas o cabecalho', () => {
  const m3u = buildM3U([]);
  assert.strictEqual(m3u, '#EXTM3U\n');
});

test('aspas em atributos sao escapadas', () => {
  const m3u = buildM3U([
    { name: 'Weird"Name', url: 'https://cdn.example/w.m3u8', gender: 'female', viewers: 1, logo: 'https://img.example/w?x="1"' },
  ]);
  assert.ok(!m3u.includes('"1"') || m3u.includes("'1'"));
  assert.ok(m3u.includes("tvg-name=\"Weird'Name\""));
});

test('rotulos de genero conhecidos e desconhecidos', () => {
  assert.strictEqual(genderLabel('female'), 'Female');
  assert.strictEqual(genderLabel('transgender'), 'Trans');
  assert.strictEqual(genderLabel('outra'), 'Cam4');
});