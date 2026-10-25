'use strict';

/**
 * github.js — Publicacao do arquivo M3U via API oficial do GitHub.
 *
 * Fluxo de publicacao (Contents API):
 *   1. GET /repos/{repo}/contents/{path}?ref={branch} -> obtem o SHA atual
 *      do arquivo (obrigatorio para atualizar um arquivo existente).
 *   2. PUT /repos/{repo}/contents/{path} com { message, content, sha, branch }.
 *      - 409/422 de conflito de SHA: re-obtem o SHA e tenta uma unica vez
 *        novamente (outro processo pode ter publicado antes).
 *      - 401: erro de autenticacao (token invalido/sem permissao).
 *      - 403 com x-ratelimit-remaining: 0 -> limite de requisicoes atingido.
 *   3. Confirmacao: a resposta 200/201 do PUT ja confirma o commit
 *      (retorna commit.sha). Em seguida, o conteudo cru publicado em
 *      raw.githubusercontent.com e verificado ate 4 vezes (a CDN pode
 *      levar alguns segundos para propagar).
 */

const { config } = require('./config');

class GitHubAuthError extends Error {}
class GitHubRateLimitError extends Error {}
class GitHubConflictError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GitHubPublisher {
  /**
   * @param {object} opts  { repo, branch, filePath, token, apiBase, rawUrl, fetchImpl }
   */
  constructor(opts = {}) {
    this.repo = opts.repo || config.githubRepo;
    this.branch = opts.branch || config.githubBranch;
    this.filePath = opts.filePath || config.githubFilePath;
    this.token = opts.token !== undefined ? opts.token : config.githubToken;
    this.apiBase = opts.apiBase || config.githubApiBase;
    this.rawUrl =
      opts.rawUrl ||
      `https://raw.githubusercontent.com/${this.repo}/${this.branch}/${this.filePath}`;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.logger = opts.logger || (() => {});
  }

  get configured() {
    return Boolean(this.token);
  }

  async api(method, path, body, extraHeaders = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cam1-playlist-system',
      ...extraHeaders,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const url = `${this.apiBase}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    if (res.status === 401) {
      throw new GitHubAuthError('GitHub: autenticacao falhou (401). Token invalido, expirado ou sem permissao de Contents.');
    }
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining === '0') {
        const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : 'desconhecido';
        throw new GitHubRateLimitError(`GitHub: limite de requisicoes atingido (403). Reset em ${resetAt}.`);
      }
      const text = await res.text();
      throw new Error(`GitHub: acesso negado (403). ${text.slice(0, 300)}`);
    }

    return res;
  }

  /** Informacoes do arquivo publicado no repo. null se o arquivo nao existe. */
  async getFileInfo() {
    const res = await this.api(
      'GET',
      `/repos/${this.repo}/contents/${encodeURIComponent(this.filePath)}?ref=${encodeURIComponent(this.branch)}`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub: falha ao ler o arquivo (HTTP ${res.status}). ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return { sha: data.sha, size: data.size, htmlUrl: data.html_url };
  }

  /** Conteudo cru atual publicado (sem autenticacao; repositorio publico). */
  async fetchRawCurrent(timeoutMs = 30000) {
    const res = await this.fetchImpl(this.rawUrl, {
      headers: { 'User-Agent': 'cam1-playlist-system' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Falha ao buscar playlist publicada (HTTP ${res.status})`);
    return await res.text();
  }

  /**
   * Publica o conteudo. Retorna:
   *   { published, commitSha, fileSha, verifiedRaw, message }
   * verifiedRaw indica que o conteudo cru ja reflete a nova versao.
   */
  async publish(content, message) {
    if (!this.configured) {
      throw new GitHubAuthError('GitHub: token nao configurado (GITHUB_TOKEN no .env).');
    }

    let sha;
    try {
      const info = await this.getFileInfo();
      sha = info ? info.sha : undefined;
    } catch (e) {
      throw e;
    }

    const body = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    let res = await this.api(
      'PUT',
      `/repos/${this.repo}/contents/${encodeURIComponent(this.filePath)}`,
      body
    );

    // Conflito de SHA (409/422): outra publicacao pode ter chegado primeiro.
    // Re-obtem o SHA atual do arquivo e tenta uma unica vez novamente.
    if (res.status === 409 || res.status === 422) {
      this.logger('warn', `GitHub: conflito de SHA (HTTP ${res.status}); re-obtendo o SHA atual e tentando novamente...`);
      try { await res.text(); } catch { /* ignora */ }
      const info = await this.getFileInfo();
      body.sha = info ? info.sha : undefined;
      res = await this.api(
        'PUT',
        `/repos/${this.repo}/contents/${encodeURIComponent(this.filePath)}`,
        body
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub: publicacao falhou (HTTP ${res.status}). ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const commitSha = data.commit && data.commit.sha;
    const fileSha = data.content && data.content.sha;
    if (!commitSha) {
      throw new Error('GitHub: resposta inesperada da API (sem commit.sha) — publicacao nao confirmada.');
    }

    // Verificacao extra: o conteudo cru precisa refletir a nova versao.
    let verifiedRaw = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(2000);
      try {
        const raw = await this.fetchRawCurrent();
        if (raw !== null && raw === content) {
          verifiedRaw = true;
          break;
        }
      } catch {
        // falha de rede na verificacao: tenta de novo
      }
    }

    return { published: true, commitSha, fileSha, verifiedRaw };
  }
}

module.exports = {
  GitHubPublisher,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubConflictError,
};