const { addonBuilder, serveHTTP, getRouter } = require('stremio-addon-sdk');
const { getCatalog, getMeta, getStreams } = require('./scraper');

const manifest = {
  id: 'org.joaoe.ytsbr.pro',
  version: '1.1.0',
  name: 'YTSBR Pro',
  description: 'Catálogo de filmes, séries e animes com busca universal e alta performance',
  logo: 'https://assets.ytsbr.com/favicon-32x32.png',
  background: 'https://assets.ytsbr.com/og-image.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'filmes-alta', name: 'Filmes em Alta' },
    { type: 'series', id: 'series-alta', name: 'Séries em Alta' }
  ]
};

const builder = new addonBuilder(manifest);

// Catalog Handler
builder.defineCatalogHandler(async (args) => {
    try {
        const metas = await getCatalog(args.type);
        return { metas, cacheMaxAge: 21600 }; // 6h cache
    } catch (e) {
        return { metas: [] };
    }
});

// Meta Handler
builder.defineMetaHandler(async (args) => {
    try {
        const metaObj = await getMeta(args.type, args.id);
        return { meta: metaObj || {}, cacheMaxAge: 86400 }; // 24h cache
    } catch (e) {
        return { meta: {} };
    }
});

// Stream Handler
builder.defineStreamHandler(async (args) => {
    try {
        const streams = await getStreams(args.type, args.id);
        return { streams, cacheMaxAge: 7200 }; // 2h cache
    } catch (e) {
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();

// Vercel Detection
if (process.env.VERCEL || process.env.NOW_REGION) {
    module.exports = getRouter(addonInterface);
} else {
    const PORT = process.env.PORT || 7000;
    serveHTTP(addonInterface, { port: PORT });
    console.log(`Addon YTSBR Pro rodando em: http://127.0.0.1:${PORT}`);
}
