'use strict';

/**
 * config.js — Carregamento e validacao das configuracoes.
 *
 * Ordem de precedencia:
 *   1. Variavel de ambiente real (process.env)
 *   2. Arquivo .env do projeto
 *   3. Sobreescritas em tempo de execucao (data/config.json)
 *   4. Valores padrao
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Remove comentario final em valores nao quoted (ex.: FOO=bar # comentario)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function str(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  return String(v).trim();
}

function num(v, def) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : def;
}

function bool(v, def) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return def;
}

function list(v, def) {
  const s = str(v, '');
  if (!s) return def;
  return s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

const fileEnv = parseEnvFile(path.join(PROJECT_ROOT, '.env'));

const VALID_GENDERS = ['female', 'male', 'transgender'];

const config = {
  PROJECT_ROOT,

  // GitHub
  githubToken: str(process.env.GITHUB_TOKEN ?? fileEnv.GITHUB_TOKEN, ''),
  githubRepo: str(process.env.GITHUB_REPO ?? fileEnv.GITHUB_REPO, 'leandrorsnrz/cam1-playlist'),
  githubBranch: str(process.env.GITHUB_BRANCH ?? fileEnv.GITHUB_BRANCH, 'main'),
  githubFilePath: str(process.env.GITHUB_FILE_PATH ?? fileEnv.GITHUB_FILE_PATH, 'cam1.m3u'),

  // CAM4
  genders: null, // preenchido abaixo
  cam4PageSize: num(process.env.CAM4_PAGE_SIZE ?? fileEnv.CAM4_PAGE_SIZE, 100),
  cam4MaxPages: num(process.env.CAM4_MAX_PAGES ?? fileEnv.CAM4_MAX_PAGES, 25),
  cam4MaxRooms: num(process.env.CAM4_MAX_ROOMS ?? fileEnv.CAM4_MAX_ROOMS, 0),
  cam4IncludePrivate: bool(
    process.env.CAM4_INCLUDE_PRIVATE ?? fileEnv.CAM4_INCLUDE_PRIVATE,
    false
  ),

  // Validacao
  validateLinks: bool(process.env.VALIDATE_LINKS ?? fileEnv.VALIDATE_LINKS, true),
  validateConcurrency: num(process.env.VALIDATE_CONCURRENCY ?? fileEnv.VALIDATE_CONCURRENCY, 8),
  validateTimeoutMs: num(process.env.VALIDATE_TIMEOUT_MS ?? fileEnv.VALIDATE_TIMEOUT_MS, 15000),

  // Automacao
  updateIntervalMinutes: num(
    process.env.UPDATE_INTERVAL_MINUTES ?? fileEnv.UPDATE_INTERVAL_MINUTES,
    15
  ),
  retryBaseSeconds: num(process.env.RETRY_BASE_SECONDS ?? fileEnv.RETRY_BASE_SECONDS, 30),
  retryMaxSeconds: num(process.env.RETRY_MAX_SECONDS ?? fileEnv.RETRY_MAX_SECONDS, 1800),

  // Servidor
  port: num(process.env.PORT ?? fileEnv.PORT, 3333),
  logLevel: str(process.env.LOG_LEVEL ?? fileEnv.LOG_LEVEL, 'info'),
};

// Generos: valida contra a lista aceita pela API do CAM4
const gendersRaw = list(process.env.CAM4_GENDERS ?? fileEnv.CAM4_GENDERS, VALID_GENDERS);
config.genders = gendersRaw.filter((g) => VALID_GENDERS.includes(g));
if (config.genders.length === 0) config.genders = [...VALID_GENDERS];

// Limites de seguranca
config.cam4PageSize = Math.max(10, Math.min(config.cam4PageSize, 300));
config.cam4MaxPages = Math.max(1, Math.min(config.cam4MaxPages, 100));
config.cam4MaxRooms = Math.max(0, config.cam4MaxRooms);
config.validateConcurrency = Math.max(1, Math.min(config.validateConcurrency, 32));
config.updateIntervalMinutes = Math.max(1, config.updateIntervalMinutes);
config.retryBaseSeconds = Math.max(5, config.retryBaseSeconds);
config.retryMaxSeconds = Math.max(config.retryBaseSeconds, config.retryMaxSeconds);

config.publicPlaylistUrl =
  `https://raw.githubusercontent.com/${config.githubRepo}/` +
  `${config.githubBranch}/${config.githubFilePath}`;

config.githubApiBase = 'https://api.github.com';

/**
 * Carrega sobreescritas de tempo de execucao (data/config.json).
 * Chamado no boot do servidor; permite alterar o intervalo pela interface
 * sem editar o .env.
 */
function loadRuntimeOverrides(dataDir) {
  const file = path.join(dataDir, 'config.json');
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Number.isFinite(raw.updateIntervalMinutes) && raw.updateIntervalMinutes >= 1) {
        config.updateIntervalMinutes = raw.updateIntervalMinutes;
      }
    }
  } catch {
    // Overrides invalidos sao ignorados; a configuracao base permanece.
  }
}

function saveRuntimeOverrides(dataDir, overrides) {
  const file = path.join(dataDir, 'config.json');
  const current = {};
  try {
    if (fs.existsSync(file)) Object.assign(current, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // sobrescreve com objeto limpo se estiver corrompido
  }
  if (Number.isFinite(overrides.updateIntervalMinutes) && overrides.updateIntervalMinutes >= 1) {
    current.updateIntervalMinutes = overrides.updateIntervalMinutes;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Resumo seguro para expor na interface (nunca inclui o token). */
function publicSummary() {
  return {
    githubConfigured: Boolean(config.githubToken),
    githubRepo: config.githubRepo,
    githubBranch: config.githubBranch,
    githubFilePath: config.githubFilePath,
    publicPlaylistUrl: config.publicPlaylistUrl,
    genders: config.genders,
    cam4PageSize: config.cam4PageSize,
    cam4MaxRooms: config.cam4MaxRooms,
    cam4IncludePrivate: config.cam4IncludePrivate,
    validateLinks: config.validateLinks,
    validateConcurrency: config.validateConcurrency,
    updateIntervalMinutes: config.updateIntervalMinutes,
    port: config.port,
  };
}

module.exports = {
  PROJECT_ROOT,
  VALID_GENDERS,
  config,
  parseEnvFile,
  loadRuntimeOverrides,
  saveRuntimeOverrides,
  publicSummary,
};