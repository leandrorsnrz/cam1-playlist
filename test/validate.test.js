'use strict';

/**
 * Testes do modulo de validacao HLS com fetch simulado.
 * Regressao: salas aprovadas na 1a passada nao podem ser descartadas
 * quando a 2a passada revalida apenas as que falharam.
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateRooms, runPool, validateOne } = require('../src/validate');

const room = (name) => ({ name, url: `https://cdn.example/${name}.m3u8`, gender: 'female' });

function jsonOk() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: { getReader() { return { read: async () => ({ value: Buffer.from('#EXTM3U\n') }), cancel: async () => {} }; } },
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

test('validateRooms preserva aprovadas da 1a passada ao revalidar falhas', async () => {
  const calls = { a: 0, b: 0, c: 0 };
  const fetchImpl = async (url) => {
    const name = url.match(/(\w+)\.m3u8/)[1];
    calls[name]++;
    // "a" falha na 1a tentativa e passa na 2a; "b" e "c" sempre passam.
    if (name === 'a' && calls.a === 1) {
      return { ok: false, status: 503, statusText: 'unavailable', arrayBuffer: async () => Buffer.alloc(0) };
    }
    return jsonOk();
  };
  const { ok, failed } = await validateRooms([room('a'), room('b'), room('c')], { concurrency: 3, tries: 2, timeoutMs: 1000, fetchImpl });
  assert.strictEqual(ok.length, 3, 'todas devem terminar aprovadas');
  assert.deepStrictEqual(ok.map((r) => r.name).sort(), ['a', 'b', 'c']);
  assert.strictEqual(failed.length, 0);
  assert.strictEqual(calls.a, 2, '"a" deve ser revalidado exatamente uma vez');
  assert.strictEqual(calls.b, 1, '"b" nao deve ser revalidado');
  assert.strictEqual(calls.c, 1, '"c" nao deve ser revalidado');
});

test('validateRooms reprovada nas duas tentativas fica em failed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found', arrayBuffer: async () => Buffer.alloc(0) });
  const { ok, failed } = await validateRooms([room('x')], { concurrency: 1, tries: 2, timeoutMs: 1000, fetchImpl });
  assert.strictEqual(ok.length, 0);
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /HTTP 404/);
});

test('runPool executa tudo e preserva ordem dos resultados', async () => {
  const out = await runPool([10, 20, 30], 2, async (n) => n * 2);
  assert.deepStrictEqual(out, [20, 40, 60]);
});

test('validateOne detecta corpo que nao e manifesto', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: { getReader() { return { read: async () => ({ value: Buffer.from('<html>nao e m3u</html>') }), cancel: async () => {} }; } },
  });
  const err = await validateOne(room('y'), { timeoutMs: 1000, fetchImpl });
  assert.match(err, /nao parece um manifesto HLS/);
});