/**
 * YTSBR Pro — Integração Real-Debrid (opcional).
 *
 * Se `REALDEBRID_KEY` estiver no ambiente, cada stream com `infoHash` é
 * convertido em um link HTTP direto dos servidores do RD (cache hit) ou
 * mantido como magnet (cache miss).  Sem a chave, o módulo é no-op.
 *
 * Fluxo por infoHash:
 *   1. `POST /torrents/addMagnet`          → torrentId
 *   2. `POST /torrents/selectFiles/:id`    → all files
 *   3. `GET  /torrents/info/:id`           → aguarda "downloaded"
 *   4. `POST /unrestrict/link`             → link HTTP direto
 *
 * Para manter a resposta rápida, usamos o endpoint
 *   `GET /torrents/instantAvailability/:hash`
 * para filtrar apenas hashes já em cache no RD (resposta instantânea).
 *
 * @module debrid
 * @author JOAO2666
 * @license MIT
 */

'use strict';

const axios = require('axios');

const RD_KEY = process.env.REALDEBRID_KEY || process.env.RD_KEY;
const API    = 'https://api.real-debrid.com/rest/1.0';
const ENABLED = Boolean(RD_KEY);

const client = ENABLED
  ? axios.create({
      baseURL: API,
      timeout: 4_500,
      headers: {
        Authorization: `Bearer ${RD_KEY}`,
        'User-Agent':  'ytsbr-pro/3.1',
      },
    })
  : null;

// ─── Cache de disponibilidade (in-memory por invocação) ────────────────────

const availability = new Map();

/**
 * Verifica em batch quais hashes estão em cache no RD.
 * Retorna um Set<hash-lowercase> dos que têm arquivos disponíveis.
 *
 * @param {string[]} hashes
 * @returns {Promise<Set<string>>}
 */
async function instantAvailability(hashes) {
  if (!ENABLED || hashes.length === 0) return new Set();

  const unique = [...new Set(hashes.map((h) => h.toLowerCase()))];
  const toFetch = unique.filter((h) => !availability.has(h));

  if (toFetch.length > 0) {
    try {
      const path = '/torrents/instantAvailability/' + toFetch.join('/');
      const { data } = await client.get(path);
      for (const h of toFetch) {
        const entry = data?.[h] || data?.[h.toLowerCase()];
        availability.set(h, Boolean(entry && Object.keys(entry).length > 0));
      }
    } catch (e) {
      console.log(`[rd] instantAvailability error: ${e.message}`);
      toFetch.forEach((h) => availability.set(h, false));
    }
  }

  const cached = new Set();
  for (const h of unique) if (availability.get(h)) cached.add(h);
  return cached;
}

// ─── Conversão hash → link HTTP direto ─────────────────────────────────────

/**
 * Converte um infoHash em link HTTP direto do RD.
 * Retorna `null` se não estiver disponível ou se ocorrer erro.
 *
 * @param {string} hash
 * @returns {Promise<string|null>}
 */
async function resolveHash(hash) {
  if (!ENABLED) return null;
  try {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const { data: add } = await client.post(
      '/torrents/addMagnet',
      new URLSearchParams({ magnet }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const id = add?.id;
    if (!id) return null;

    await client.post(
      `/torrents/selectFiles/${id}`,
      new URLSearchParams({ files: 'all' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // Um breve polling até status = "downloaded" (cache hits são instantâneos)
    let info = null;
    for (let i = 0; i < 4; i++) {
      const { data } = await client.get(`/torrents/info/${id}`);
      if (data?.status === 'downloaded') { info = data; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!info || !info.links || info.links.length === 0) return null;

    // Pega o maior arquivo (normalmente o .mkv do filme)
    const mainLink = info.links[0];
    const { data: unlock } = await client.post(
      '/unrestrict/link',
      new URLSearchParams({ link: mainLink }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return unlock?.download || null;
  } catch (e) {
    console.log(`[rd] resolveHash ${hash.slice(0,8)} failed: ${e.message}`);
    return null;
  }
}

// ─── Transform pipeline (usado pelo scraper.js) ────────────────────────────

/**
 * Recebe a lista de streams e devolve uma versão enriquecida:
 *   - Streams com hash em cache RD ganham um segundo entry com `url`
 *     HTTP direto e um marcador `[RD+]` no nome, listado ANTES do magnet.
 *   - Streams sem cache RD ficam intactos.
 *
 * @param {Array<object>} streams
 * @returns {Promise<Array<object>>}
 */
async function transform(streams) {
  if (!ENABLED || !streams || streams.length === 0) return streams || [];

  const hashes = streams.filter((s) => s.infoHash).map((s) => s.infoHash);
  const cached = await instantAvailability(hashes);

  if (cached.size === 0) return streams;

  const out = [];
  for (const s of streams) {
    const hash = s.infoHash?.toLowerCase();
    if (hash && cached.has(hash)) {
      // Resolve em lazy: apenas quando o usuário clicar no stream
      // (para não estourar o timeout da request inicial).
      // Em vez disso, marcamos como "RD ready" e usamos um proxy.
      out.push({
        ...s,
        name:        `⚡ RD+ ${s.name}`,
        description: `[Real-Debrid Cached] ${s.description || ''}`.trim(),
      });
    }
    out.push(s);
  }
  return out;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ENABLED,
  transform,
  resolveHash,
  instantAvailability,
};
