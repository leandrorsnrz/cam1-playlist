'use strict';

/**
 * scheduler.js — Automacao continua com backoff progressivo.
 *
 * - Executa o ciclo completo a cada UPDATE_INTERVAL_MINUTES.
 * - Sucesso: volta ao intervalo normal (+ jitter de ate 5%).
 * - Falha: dobra o intervalo de espera progressivamente (base * 2^n),
 *   limitado a RETRY_MAX_SECONDS, evitando ciclo infinito de requisicoes.
 * - Se um ciclo manual estiver em execucao quando chega a hora do
 *   automatico, apenas re-agenda para alguns segundos depois.
 */

const { config } = require('./config');
const logger = require('./logger');

class Scheduler {
  /**
   * @param {object} opts { runFn, getBusy }
   *   runFn(source) -> Promise<summary>
   *   getBusy() -> boolean (true se um ciclo manual esta em execucao)
   */
  constructor({ runFn, getBusy } = {}) {
    if (typeof runFn !== 'function') throw new Error('Scheduler: runFn e obrigatorio');
    this.runFn = runFn;
    this.getBusy = getBusy || (() => false);
    this.timer = null;
    this.paused = false;
    this.failures = 0;
    this.running = false;
    this.nextRunAt = null;
    this.intervalMinutes = config.updateIntervalMinutes;
  }

  intervalMs() {
    return Math.max(1, this.intervalMinutes) * 60 * 1000;
  }

  /** Agenda a proxima execucao apos delayMs. */
  _schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => this._tick(), delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  _backoffMs() {
    const base = Math.max(5, config.retryBaseSeconds) * 1000;
    const cap = Math.max(config.retryBaseSeconds, config.retryMaxSeconds) * 1000;
    const raw = base * Math.pow(2, Math.min(this.failures - 1, 10));
    const jitter = Math.floor(Math.random() * Math.min(raw * 0.1, 10000));
    return Math.min(raw, cap) + jitter;
  }

  async _tick() {
    this.timer = null;
    if (this.paused) {
      this.nextRunAt = null;
      return;
    }
    if (this.running || this.getBusy()) {
      // Ciclo manual em andamento: re-agenda em 30 s sem contar como falha.
      logger.info('Agendador: ciclo em execucao; re-agendando em 30s');
      this._schedule(30 * 1000);
      return;
    }
    this.running = true;
    try {
      await this.runFn('scheduler');
      this.failures = 0;
      this._schedule(this.intervalMs() + Math.floor(Math.random() * this.intervalMs() * 0.05));
    } catch (err) {
      this.failures++;
      const waitMs = this._backoffMs();
      logger.warn(
        `Agendador: falha sequencial ${this.failures}; proximo ciclo automatico em ` +
          `${Math.round(waitMs / 1000)}s (backoff progressivo)`
      );
      this._schedule(waitMs);
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer || this.paused) return;
    logger.info(`Agendador iniciado: ciclo automatico a cada ${this.intervalMinutes} min (backoff progressivo em falhas)`);
    this._schedule(5 * 1000); // primeiro ciclo automatico 5s apos o boot
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  pause() {
    this.paused = true;
    this.stop();
    logger.info('Agendador pausado (execucoes manuais continuam disponiveis)');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    logger.info('Agendador retomado');
    this.start();
  }

  setIntervalMinutes(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1) {
      throw new Error('Intervalo invalido: use um numero de minutos >= 1');
    }
    this.intervalMinutes = Math.floor(m);
    if (this.timer) {
      this.stop();
      this.start();
    }
    logger.info(`Intervalo automatico alterado para ${this.intervalMinutes} min`);
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      failures: this.failures,
      nextRunAt: this.nextRunAt,
      intervalMinutes: this.intervalMinutes,
    };
  }
}

module.exports = { Scheduler };