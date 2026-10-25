'use strict';

/**
 * Testes do modulo de publicacao no GitHub (API Contents) com fetch simulado.
 * Executar: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { GitHubPublisher, GitHubAuthError, GitHubRateLimitError } = require('../src/github');

const REPO = 'user/repo';
const FILE = 'cam1.m3u';
const BRANCH = 'main';

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function makePublisher(callLog, handler) {
  return new GitHubPublisher({
    repo: REPO,
    branch: BRANCH,
    filePath: FILE,
    token: 'token-teste',
    rawUrl: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}`,
    fetchImpl: async (url, init = {}) => {
      callLog.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      return handler(callLog[callLog.length - 1]);
    },
    logger: () => {},
  });
}

test('publicacao de atualizacao usa o SHA atual e confirma o commit', async () => {
  const calls = [];
  const pub = makePublisher(calls, (call) => {
    if (call.method === 'GET' && call.url.includes('/contents/')) {
      return jsonRes(200, { sha: 'sha-antigo', size: 10, html_url: 'x' });
    }
    if (call.method === 'PUT') {
      assert.strictEqual(call.body.sha, 'sha-antigo');
      return jsonRes(200, { commit: { sha: 'commit-novo' }, content: { sha: 'file-novo' } });
    }
    // verificacao raw
    return jsonRes(200, call.__raw ? {} : {});
  });
  // raw verification: sobrescreve fetchRawCurrent com resposta estavel
  pub.fetchRawCurrent = async () => 'CONTEUDO';
  const result = await pub.publish('CONTEUDO', 'mensagem');
  assert.strictEqual(result.published, true);
  assert.strictEqual(result.commitSha, 'commit-novo');
  assert.strictEqual(result.fileSha, 'file-novo');
  assert.strictEqual(result.verifiedRaw, true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.body.content, 'conteudo base64 presente');
  assert.strictEqual(Buffer.from(put.body.content, 'base64').toString('utf8'), 'CONTEUDO');
});

test('arquivo inexistente (404) publica sem SHA (criacao)', async () => {
  const calls = [];
  const pub = makePublisher(calls, (call) => {
    if (call.method === 'GET') return jsonRes(404, { message: 'Not Found' });
    if (call.method === 'PUT') {
      assert.strictEqual(call.body.sha, undefined);
      return jsonRes(201, { commit: { sha: 'c1' }, content: { sha: 'f1' } });
    }
    return jsonRes(200, {});
  });
  pub.fetchRawCurrent = async () => 'CONTEUDO';
  const result = await pub.publish('CONTEUDO', 'cria arquivo');
  assert.strictEqual(result.published, true);
});

test('conflito de SHA (409) re-obtem o SHA e tenta novamente', async () => {
  const calls = [];
  let putCount = 0;
  const pub = makePublisher(calls, (call) => {
    if (call.method === 'GET' && call.url.includes('/contents/')) {
      return jsonRes(200, { sha: putCount === 0 ? 'sha-1' : 'sha-2' });
    }
    if (call.method === 'PUT') {
      putCount++;
      if (putCount === 1) return jsonRes(409, { message: 'does not match' });
      assert.strictEqual(call.body.sha, 'sha-2');
      return jsonRes(200, { commit: { sha: 'c2' }, content: { sha: 'f2' } });
    }
    return jsonRes(200, {});
  });
  pub.fetchRawCurrent = async () => 'CONTEUDO';
  const result = await pub.publish('CONTEUDO', 'msg');
  assert.strictEqual(result.commitSha, 'c2');
  assert.strictEqual(putCount, 2);
});

test('401 gera GitHubAuthError com mensagem clara', async () => {
  const calls = [];
  const pub = makePublisher(calls, () => jsonRes(401, { message: 'Bad credentials' }));
  await assert.rejects(() => pub.publish('x', 'm'), (e) => e instanceof GitHubAuthError && /autenticacao/i.test(e.message));
});

test('403 com limite de requisicoes gera GitHubRateLimitError', async () => {
  const calls = [];
  const pub = makePublisher(calls, () =>
    jsonRes(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' })
  );
  await assert.rejects(() => pub.publish('x', 'm'), (e) => e instanceof GitHubRateLimitError && /limite/i.test(e.message));
});

test('publisher sem token nao tenta publicar', async () => {
  const pub = new GitHubPublisher({ repo: REPO, branch: BRANCH, filePath: FILE, token: '', fetchImpl: async () => { throw new Error('nao deveria chamar'); } });
  await assert.rejects(() => pub.publish('x', 'm'), (e) => e instanceof GitHubAuthError && /token nao configurado/i.test(e.message));
  assert.strictEqual(pub.configured, false);
});

test('getFileInfo retorna null para arquivo inexistente', async () => {
  const calls = [];
  const pub = makePublisher(calls, () => jsonRes(404, { message: 'Not Found' }));
  const info = await pub.getFileInfo();
  assert.strictEqual(info, null);
});