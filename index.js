const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getCatalog, getMeta, getStreams } = require('./scraper');

const manifest = {
  id: 'org.joaoe.ytsbr',
  version: '1.0.0',
  name: 'YTSBR Catalog',
  description: 'Catálogo customizado para filmes e séries via YTS Brasil',
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
    console.log('Catalog request:', args);
    const metas = await getCatalog(args.type);
    return { metas };
});

// Meta Handler
builder.defineMetaHandler(async (args) => {
    console.log('Meta request:', args);
    const metaObj = await getMeta(args.type, args.id);
    if (metaObj) {
        return { meta: metaObj };
    }
    return { meta: {} };
});

// Stream Handler
builder.defineStreamHandler(async (args) => {
    console.log('Stream request:', args);
    const streams = await getStreams(args.type, args.id);
    return { streams };
});

// Server Initialization
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Addon YTSBR listening on port ${PORT}`);
