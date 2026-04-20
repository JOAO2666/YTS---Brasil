/**
 * YTSBR Pro — Cache de torrents em Supabase (Postgres).
 *
 * Se as variáveis `SUPABASE_URL` e `SUPABASE_KEY` estiverem definidas,
 * usa Supabase como cache persistente (leitura + escrita).
 * Caso contrário degrada para no-op: todas as funções retornam
 * imediatamente sem erro, mantendo o addon 100% funcional via scraping.
 *
 * @module db
 * @author JOAO2666
 * @license MIT
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
const supabase = URL && KEY
  ? createClient(URL, KEY, { auth: { persistSession: false } })
  : null;

const ENABLED = Boolean(supabase);
const TABLE   = 'torrents';

// TTL do cache: 72 h. Entradas mais antigas são ignoradas na leitura mas
// não deletadas automaticamente (o indexer repopula).
const MAX_AGE_MS = 72 * 60 * 60 * 1_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeId(imdbId, season, episode) {
  return {
    imdb_id: String(imdbId).toLowerCase(),
    season:  season  ?? 0,
    episode: episode ?? 0,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Retorna streams cacheados, ou `null` se não houver (cache-miss).
 * Um array vazio significa "sabemos que não tem nada" (cache-hit negativo).
 *
 * @param {string}      imdbId
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array<object>|null>}
 */
async function readCache(imdbId, season, episode) {
  if (!ENABLED) return null;

  const key = normalizeId(imdbId, season, episode);
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('provider,name,description,info_hash,url,quality,seeders,created_at')
      .eq('imdb_id', key.imdb_id)
      .eq('season',  key.season)
      .eq('episode', key.episode)
      .gte('created_at', cutoff)
      .order('seeders', { ascending: false, nullsFirst: false });

    if (error) {
      console.log(`[db] read error: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) return null;

    return data.map((row) => {
      const stream = {
        name:        row.name,
        description: row.description || '',
      };
      if (row.info_hash) stream.infoHash = row.info_hash;
      else if (row.url)  stream.url = row.url;
      return stream;
    });
  } catch (e) {
    console.log(`[db] read exception: ${e.message}`);
    return null;
  }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Persiste streams no cache (upsert por info_hash + imdb/season/episode).
 * Chamada em "write-behind": não bloqueia a resposta ao usuário.
 *
 * @param {string}         imdbId
 * @param {number|null}    season
 * @param {number|null}    episode
 * @param {Array<object>}  streams
 */
async function writeCache(imdbId, season, episode, streams) {
  if (!ENABLED) return;
  if (!streams || streams.length === 0) return;

  const key = normalizeId(imdbId, season, episode);

  const rows = streams
    .map((s) => ({
      ...key,
      provider:    (s.name || '').split(' ')[0] || 'unknown',
      name:        s.name || '',
      description: s.description || '',
      info_hash:   s.infoHash || null,
      url:         s.url || null,
      quality:     inferQuality(s.name + ' ' + (s.description || '')),
      seeders:     parseSeedersFromDescription(s.description || ''),
      created_at:  new Date().toISOString(),
    }))
    .filter((r) => r.info_hash || r.url);

  if (rows.length === 0) return;

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, {
        onConflict: 'imdb_id,season,episode,info_hash',
        ignoreDuplicates: false,
      });
    if (error) console.log(`[db] write error: ${error.message}`);
  } catch (e) {
    console.log(`[db] write exception: ${e.message}`);
  }
}

function inferQuality(text) {
  const t = (text || '').toString();
  if (/2160p|4K|UHD/i.test(t)) return '2160p';
  if (/1080p|FULL.?HD/i.test(t)) return '1080p';
  if (/720p/i.test(t)) return '720p';
  if (/480p/i.test(t)) return '480p';
  return null;
}

function parseSeedersFromDescription(desc) {
  const m = (desc || '').match(/👥\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ENABLED,
  readCache,
  writeCache,
};
