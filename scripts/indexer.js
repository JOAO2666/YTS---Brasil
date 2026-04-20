#!/usr/bin/env node
/**
 * YTSBR Pro — Indexer worker.
 *
 * Roda periodicamente (ex.: GitHub Action a cada 6 h) e pré-popula o
 * cache Supabase com torrents dos títulos mais populares do momento.
 *
 * Algoritmo:
 *   1. Busca top N filmes e top N séries via TMDB (Popular + Trending).
 *   2. Para cada título, chama `getStreams(type, imdbId)` — o scraper
 *      salva tudo no Supabase automaticamente via write-behind.
 *   3. Para séries, indexa também a temporada mais recente.
 *
 * Variáveis de ambiente obrigatórias:
 *   SUPABASE_URL, SUPABASE_KEY
 *
 * Opcionais:
 *   TMDB_KEY      — se não fornecida, usa a chave pública do scraper
 *   INDEXER_LIMIT — quantidade de títulos por tipo (padrão 50)
 *
 * Execução manual:
 *   node scripts/indexer.js
 */

'use strict';

const axios = require('axios');
const { getStreams } = require('../scraper');
const db = require('../db');

const TMDB_KEY = process.env.TMDB_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const LIMIT    = parseInt(process.env.INDEXER_LIMIT || '50', 10);

const CONCURRENCY = 3;      // títulos processados em paralelo
const PAUSE_MS    = 1_500;  // pausa entre lotes (evita rate-limit dos sites)

// ─── TMDB helpers ──────────────────────────────────────────────────────────

async function tmdbGet(path, params = {}) {
  const url = `https://api.themoviedb.org/3${path}`;
  const { data } = await axios.get(url, {
    params: { api_key: TMDB_KEY, language: 'pt-BR', ...params },
    timeout: 10_000,
  });
  return data;
}

/** Pega IMDb ID de um filme/serie TMDB. */
async function tmdbExternalIds(type, id) {
  try {
    const path = type === 'movie' ? `/movie/${id}/external_ids` : `/tv/${id}/external_ids`;
    const data = await tmdbGet(path);
    return data?.imdb_id || null;
  } catch {
    return null;
  }
}

async function tmdbLastSeason(id) {
  try {
    const data = await tmdbGet(`/tv/${id}`);
    const seasons = (data?.seasons || []).filter((s) => s.season_number > 0);
    if (seasons.length === 0) return null;
    return seasons[seasons.length - 1].season_number;
  } catch {
    return null;
  }
}

/** Lista top títulos usando a API TMDB. */
async function collectTopTitles(kind) {
  const endpoints = kind === 'movie'
    ? ['/movie/popular', '/movie/now_playing', '/trending/movie/week']
    : ['/tv/popular', '/tv/on_the_air', '/trending/tv/week'];

  const ids = new Map(); // id → name
  for (const ep of endpoints) {
    let page = 1;
    while (ids.size < LIMIT && page <= 5) {
      try {
        const data = await tmdbGet(ep, { page });
        for (const item of data?.results || []) {
          const name = item.title || item.name;
          if (!ids.has(item.id)) ids.set(item.id, name);
          if (ids.size >= LIMIT) break;
        }
        page++;
      } catch (e) {
        console.log(`[indexer] TMDB ${ep} page ${page} failed: ${e.message}`);
        break;
      }
    }
    if (ids.size >= LIMIT) break;
  }
  return [...ids.entries()].slice(0, LIMIT).map(([id, name]) => ({ id, name }));
}

// ─── Worker logic ──────────────────────────────────────────────────────────

async function indexMovie(tmdbId, name) {
  const imdb = await tmdbExternalIds('movie', tmdbId);
  if (!imdb) {
    console.log(`  ⚠ ${name}: sem IMDb ID`);
    return 0;
  }
  const before = Date.now();
  try {
    const streams = await getStreams('movie', imdb);
    console.log(`  ✓ ${name} → ${streams.length} streams (${Date.now() - before}ms)`);
    return streams.length;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    return 0;
  }
}

async function indexSeries(tmdbId, name) {
  const imdb = await tmdbExternalIds('series', tmdbId);
  if (!imdb) {
    console.log(`  ⚠ ${name}: sem IMDb ID`);
    return 0;
  }
  const season = await tmdbLastSeason(tmdbId);
  if (!season) {
    console.log(`  ⚠ ${name}: sem temporadas`);
    return 0;
  }

  // Indexa episódio 1 (garante que pelo menos existe na busca) +
  // episódio mais provável de estar sendo pedido (último).
  const tasks = [1, 2, 3].map((ep) => ({ imdb, season, ep }));
  let total = 0;
  for (const t of tasks) {
    try {
      const id = `${t.imdb}:${t.season}:${t.ep}`;
      const streams = await getStreams('series', id);
      total += streams.length;
    } catch { /* next */ }
  }
  console.log(`  ✓ ${name} S${season} → ${total} streams`);
  return total;
}

async function processBatch(items, kind) {
  let totalStreams = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((it) =>
        kind === 'movie'
          ? indexMovie(it.id, it.name)
          : indexSeries(it.id, it.name)
      )
    );
    totalStreams += results.reduce((a, b) => a + b, 0);
    if (i + CONCURRENCY < items.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }
  return totalStreams;
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('═'.repeat(62));
  console.log(`▶ YTSBR Indexer — limit ${LIMIT} por tipo`);
  console.log('═'.repeat(62));

  if (!db.ENABLED) {
    console.error('✗ SUPABASE_URL/SUPABASE_KEY não definidos. Abortando.');
    process.exit(1);
  }

  const start = Date.now();

  console.log('\n▶ Coletando top filmes…');
  const movies = await collectTopTitles('movie');
  console.log(`  ${movies.length} filmes selecionados.\n`);
  const mStreams = await processBatch(movies, 'movie');

  console.log('\n▶ Coletando top séries…');
  const series = await collectTopTitles('series');
  console.log(`  ${series.length} séries selecionadas.\n`);
  const sStreams = await processBatch(series, 'series');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + '═'.repeat(62));
  console.log(`✓ Indexação completa em ${elapsed}s`);
  console.log(`  ${movies.length} filmes → ${mStreams} streams`);
  console.log(`  ${series.length} séries → ${sStreams} streams`);
  console.log('═'.repeat(62));

  process.exit(0);
})().catch((e) => {
  console.error('✗ Indexer failed:', e);
  process.exit(1);
});
