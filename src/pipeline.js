'use strict';

/**
 * pipeline.js — Orquestracao de um ciclo completo de atualizacao.
 *
 * Etapas:
 *   1. Descobrir transmisses ao vivo (API GraphQL + fallback HTML).
 *   2. Filtrar shows privados (opcional) e remover duplicadas.
 *   3. Validar os manifestos HLS.
 *   4. Gerar o M3U completo.
 *   5. Comparar com a versao publicada atualmente (conteudo cru do GitHub).
 *   6. Publicar via API oficial somente quando houver mudanca real.
 *   7. Atualizar o estado (contadores, historico) para a interface.
 */

const fs = require('node:fs');
const path = require('node:path');
const { config, PROJECT_ROOT } = require('./config');
const logger = require('./logger');
const { discoverRooms } = require('./cam4');
const { validateRooms } = require('./validate');
const { buildM3U, dedupeRooms } = require('./m3u');
const { GitHubPublisher, GitHubAuthError, GitHubRateLimitError } = require('./github');
const { loadState, saveState, pushHistory } = require('./state');

const DATA_DIR = path.join(PROJECT_ROOT, 'data');

let busy = false;
const publisher = new GitHubPublisher({ logger: (lvl, msg) => logger[lvl](msg) });

/** Indica se um ciclo ja esta em execucao. */
function isBusy() {
  return busy;
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return iso;
  }
}

/**
 * Executa um ciclo completo.
 * @param {object} opts  { publish: boolean, source: 'manual'|'scheduler'|'cli' }
 * @returns {object} resumo do ciclo para a interface/CLI
 */
async function runCycle({ publish = true, source = 'manual' } = {}) {
  if (busy) {
    const err = new Error('Um ciclo ja esta em execucao. Aguarde a conclusao.');
    err.code = 'BUSY';
    throw err;
  }
  busy = true;
  const startedAt = new Date().toISOString();
  logger.info(`=== Ciclo iniciado (${source}) ===`);

  const summary = {
    ok: false,
    startedAt,
    finishedAt: null,
    source,
    published: null,
    discovered: 0,
    active: 0,
    invalid: 0,
    added: [],
    removed: [],
    commitSha: null,
    message: '',
  };

  try {
    // ---- 1. Descoberta --------------------------------------------------
    const { rooms: found, viaGql, apiFailures } = await discoverRooms(
      (lvl, msg, extra) => logger[lvl](msg, extra)
    );
    if (viaGql === false && found.length === 0) {
      const err = new Error('Nenhuma transmissao encontrada: API e fallback do diretorio falharam.');
      // Codigo de erro classificado: ambientes sem acesso ao CAM4 (ex.: nuvem
      // com IP de datacenter bloqueado) tratam esse caso como resultado neutro.
      err.code = 'DISCOVERY_UNAVAILABLE';
      throw err;
    }
    logger.info(`Descoberta concluida: ${found.length} salas unicas ao vivo (API GraphQL: ${viaGql ? 'ok' : 'falhou'}${apiFailures ? `, ${apiFailures} paginas com falha` : ''})`);
    summary.discovered = found.length;

    // ---- 2. Filtros e deduplicacao --------------------------------------
    let rooms = found;
    if (!config.cam4IncludePrivate) {
      const priv = rooms.filter((r) => r.showType === 'PRIVATE_SHOW');
      if (priv.length) {
        logger.info(`Ignorando ${priv.length} salas PRIVATE_SHOW (configuracao padrao)`);
        rooms = rooms.filter((r) => r.showType !== 'PRIVATE_SHOW');
      }
    }
    rooms = dedupeRooms(rooms);
    if (config.cam4MaxRooms && rooms.length > config.cam4MaxRooms) {
      logger.info(`Limitando a ${config.cam4MaxRooms} salas (CAM4_MAX_ROOMS)`);
      rooms = rooms.slice(0, config.cam4MaxRooms);
    }

    // ---- 3. Validacao ---------------------------------------------------
    let activeRooms = rooms;
    if (config.validateLinks) {
      logger.info(`Validando ${rooms.length} manifestos HLS (${config.validateConcurrency} conexoes simultaneas)...`);
      const { ok, failed } = await validateRooms(
        rooms,
        { concurrency: config.validateConcurrency, tries: 2, timeoutMs: config.validateTimeoutMs },
        (lvl, msg) => logger[lvl](msg)
      );
      activeRooms = ok;
      summary.invalid = failed.length;
      logger.info(`Validacao concluida: ${ok.length} ativos, ${failed.length} invalidos/indisponiveis`);
      for (const f of failed.slice(0, 10)) {
        logger.debug(`Link invalido: ${f.room.name}: ${f.error}`);
      }
    } else {
      logger.warn('Validacao de links desativada (VALIDATE_LINKS=false)');
    }

    summary.active = activeRooms.length;
    if (!activeRooms.length) {
      throw new Error('Nenhuma transmissao validada; playlist nao foi alterada.');
    }

    // ---- 4. Geracao ------------------------------------------------------
    const content = buildM3U(activeRooms, { genderOrder: config.genders });
    logger.info(`Playlist gerada: ${activeRooms.length} entradas`);

    // Copia local da playlist para a interface (GET /api/playlist)
    // e para uso offline. Falha aqui nao aborta o ciclo.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'cam1.m3u'), content, 'utf8');
    } catch (e) {
      logger.warn(`Nao foi possivel salvar a copia local da playlist: ${e.message}`);
    }

    // ---- 5/6. Comparacao e publicacao -----------------------------------
    const state = loadState(DATA_DIR);
    const prevNames = new Set((state.lastNames || []).map((n) => String(n).toLowerCase()));
    const nowNames = activeRooms.map((r) => r.name);
    const nowSet = new Set(nowNames.map((n) => n.toLowerCase()));
    summary.added = nowNames.filter((n) => !prevNames.has(n.toLowerCase()));
    summary.removed = (state.lastNames || []).filter((n) => !nowSet.has(String(n).toLowerCase()));
    if (summary.added.length) logger.info(`Novas transmissoes: ${summary.added.length}`);
    if (summary.removed.length) logger.info(`Removidas (offline): ${summary.removed.length}`);

    if (publish) {
      if (!publisher.configured) {
        logger.warn('Publicacao pulada: GITHUB_TOKEN nao configurado no .env');
        summary.published = false;
        summary.message = 'Playlist gerada localmente, mas o token do GitHub nao esta configurado.';
        state.github.status = 'not-configured';
        state.github.lastMessage = 'Token nao configurado';
      } else {
        const current = await publisher.fetchRawCurrent();
        if (current !== null && current === content) {
          logger.info('Playlist publicada ja esta sincronizada; nenhum commit necessario.');
          summary.published = false;
          summary.message = 'Sem mudancas desde a ultima publicacao.';
          state.github.status = 'ok';
          state.github.lastMessage = 'Sem mudancas';
        } else {
          const commitMsg =
            `Atualiza playlist Cam4: ${activeRooms.length} salas ativas` +
            ` (+${summary.added.length}/-${summary.removed.length}) em ${new Date().toISOString()}`;
          logger.info('Conteudo mudou; publicando no GitHub via API oficial...');
          const result = await publisher.publish(content, commitMsg);
          summary.published = true;
          summary.commitSha = result.commitSha;
          summary.message = `Publicado no GitHub (commit ${String(result.commitSha).slice(0, 7)}).` +
            (result.verifiedRaw ? ' Conteudo verificado na URL publica.' : ' Commit confirmado pela API; propagacao da CDN ainda pendente.');
          logger.info(summary.message);
          if (!result.verifiedRaw) {
            logger.warn('A URL publica ainda mostra a versao anterior (propagacao da CDN); o commit ja esta confirmado.');
          }
          state.github.status = 'ok';
          state.github.lastPublishAt = new Date().toISOString();
          state.github.lastCommitSha = result.commitSha;
          state.github.lastFileSha = result.fileSha;
          state.github.lastVerifiedRaw = result.verifiedRaw;
          state.github.lastMessage = summary.message;
          state.publishHistory = pushHistory(state.publishHistory, {
            at: new Date().toISOString(),
            commitSha: result.commitSha,
            entries: activeRooms.length,
            verifiedRaw: result.verifiedRaw,
          });
        }
      }
    } else {
      summary.published = null; // verificacao apenas
      summary.message = 'Verificacao concluida (publicacao nao solicitada).';
    }

    // ---- 7. Estado -------------------------------------------------------
    summary.ok = true;
    summary.finishedAt = new Date().toISOString();
    state.lastRunAt = summary.finishedAt;
    state.lastSuccessAt = summary.finishedAt;
    state.lastError = null;
    state.stats = { discovered: summary.discovered, active: summary.active, invalid: summary.invalid };
    state.lastAdded = summary.added;
    state.lastRemoved = summary.removed;
    state.lastNames = nowNames;
    state.runHistory = pushHistory(state.runHistory, {
      at: summary.finishedAt,
      source,
      ok: true,
      discovered: summary.discovered,
      active: summary.active,
      invalid: summary.invalid,
      published: summary.published,
    });
    saveState(DATA_DIR, state);
    logger.info(`=== Ciclo concluido com sucesso em ${((Date.now() - Date.parse(startedAt)) / 1000).toFixed(1)}s ===`);
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.finishedAt = new Date().toISOString();
    summary.message = err.message;
    logger.error(`Ciclo falhou: ${err.message}`);

    try {
      const state = loadState(DATA_DIR);
      state.lastRunAt = summary.finishedAt;
      state.lastError = err.message;
      if (err instanceof GitHubAuthError) {
        state.github.status = 'error';
        state.github.lastMessage = err.message;
      } else if (err instanceof GitHubRateLimitError) {
        state.github.status = 'error';
        state.github.lastMessage = err.message;
      }
      state.runHistory = pushHistory(state.runHistory, {
        at: summary.finishedAt,
        source,
        ok: false,
        error: err.message,
      });
      saveState(DATA_DIR, state);
    } catch (e) {
      logger.error(`Falha ao salvar estado apos erro: ${e.message}`);
    }
    throw err;
  } finally {
    busy = false;
  }
}

module.exports = { runCycle, isBusy, DATA_DIR, publisher, fmtDate };