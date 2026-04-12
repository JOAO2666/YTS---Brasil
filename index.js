/**
 * YTSBR Pro — Stremio Addon Server
 *
 * Entry point for the Stremio addon. Defines the manifest, registers
 * handlers for catalog/meta/stream, and bootstraps either a local
 * Express server or a Vercel serverless export depending on the runtime.
 *
 * @module index
 * @author JOAO2666
 * @license MIT
 */

'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { getCatalog, getMeta, getStreams } = require('./scraper');

// ─── Manifest ────────────────────────────────────────────────────────────────

const manifest = {
  id: 'org.joaoe.ytsbr.pro',
  version: '2.0.0',
  name: 'YTSBR Pro',
  description:
    'Filmes, séries e animes do YTS Brasil — busca universal com tradução automática TMDB.',
  logo: 'https://assets.ytsbr.com/favicon-32x32.png',
  background: 'https://assets.ytsbr.com/og-image.jpg',
  contactEmail: 'joao2666@users.noreply.github.com',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie',  id: 'ytsbr-filmes', name: 'YTSBR — Filmes em Alta' },
    { type: 'series', id: 'ytsbr-series', name: 'YTSBR — Séries em Alta' },
  ],
};

// ─── Addon Builder ───────────────────────────────────────────────────────────

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type }) => {
  try {
    const metas = await getCatalog(type);
    return { metas, cacheMaxAge: 21_600 }; // 6 h
  } catch {
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const meta = await getMeta(type, id);
    return { meta: meta || {}, cacheMaxAge: 86_400 }; // 24 h
  } catch {
    return { meta: {} };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const streams = await getStreams(type, id);
    return { streams, cacheMaxAge: 3_600 }; // 1 h
  } catch {
    return { streams: [] };
  }
});

// ─── HTTP Layer ──────────────────────────────────────────────────────────────

const addonInterface = builder.getInterface();
const app = express();

// CORS — required so Stremio clients (web, mobile, desktop) can reach us.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/', getRouter(addonInterface));

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (process.env.VERCEL || process.env.NOW_REGION) {
  // Serverless (Vercel)
  module.exports = app;
} else {
  // Standalone
  const PORT = process.env.PORT || 7000;
  app.listen(PORT, () => {
    console.log(`[YTSBR] Addon online → http://localhost:${PORT}/manifest.json`);
  });
}
