'use strict';

/**
 * m3u.js — Geracao da playlist M3U padrao.
 *
 * Formato gerado:
 *
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",
 *   Cam4 {nome} [{Genero}] ({N} viewers)
 *   {url .m3u8}
 *
 * Caracteristicas:
 * - Deduplicacao por usuario (nome em minusculas; mantem a sala com mais
 *   espectadores) e por URL.
 * - Ordenacao estavel: genero (ordem configurada) -> viewers desc -> nome.
 *   Ordenacao estavel e essencial: evita commits desnecessarios quando
 *   apenas a ordem "empata".
 * - Nenhum carimbo de data/hora no conteudo: a comparacao entre versoes
 *   so detecta mudanca real de salas/links.
 */

const GENDER_LABELS = { female: 'Female', male: 'Male', transgender: 'Trans' };

function genderLabel(gender) {
  return GENDER_LABELS[gender] || 'Cam4';
}

function attrEscape(value) {
  return String(value).replace(/"/g, "'");
}

/**
 * Remove duplicadas por nome (case-insensitive). Em conflito, mantem a
 * entrada com mais viewers e URL nao vazia.
 */
function dedupeRooms(rooms) {
  const byName = new Map();
  for (const room of rooms) {
    if (!room || !room.name || !room.url) continue;
    const key = String(room.name).toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, room);
    } else if (room.viewers > existing.viewers) {
      byName.set(key, room);
    }
  }
  return [...byName.values()];
}

/**
 * Ordenacao estavel para geracao deterministica.
 * genderOrder define a precedencia dos generos (ordem do .env).
 */
function sortRooms(rooms, genderOrder = ['female', 'male', 'transgender']) {
  const rank = (g) => {
    const i = genderOrder.indexOf(String(g || '').toLowerCase());
    return i === -1 ? genderOrder.length : i;
  };
  return rooms.slice().sort((a, b) => {
    const g = rank(a.gender) - rank(b.gender);
    if (g !== 0) return g;
    if (b.viewers !== a.viewers) return b.viewers - a.viewers;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'variant' });
  });
}

/**
 * Gera o conteudo M3U completo a partir das salas validadas.
 * Retorna string pronta para publicar.
 */
function buildM3U(rooms, { genderOrder } = {}) {
  const order = Array.isArray(genderOrder) && genderOrder.length ? genderOrder : ['female', 'male', 'transgender'];
  const clean = dedupeRooms(rooms);
  const sorted = sortRooms(clean, order);

  const lines = ['#EXTM3U'];
  for (const room of sorted) {
    const label = `Cam4 ${room.name} [${genderLabel(room.gender)}] (${room.viewers} viewers)`;
    const attrs = [];
    attrs.push(`tvg-id="${attrEscape(room.name.toLowerCase())}@cam4"`);
    attrs.push(`tvg-name="${attrEscape(room.name)}"`);
    if (room.logo) attrs.push(`tvg-logo="${attrEscape(room.logo)}"`);
    attrs.push(`group-title="Cam4 ${attrEscape(genderLabel(room.gender))}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${label}`);
    lines.push(room.url);
  }
  return lines.join('\n') + '\n';
}

/** Conta entradas #EXTINF de um conteudo M3U (para diagnostico). */
function countEntries(m3uContent) {
  return (String(m3uContent).match(/^#EXTINF/mg) || []).length;
}

module.exports = { GENDER_LABELS, genderLabel, dedupeRooms, sortRooms, buildM3U, countEntries, attrEscape };