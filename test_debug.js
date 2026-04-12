const { getStreams } = require('./scraper');

const tests = [
    { name: 'Divertida Mente 2', type: 'movie', id: 'tt22022452' },
    { name: 'Vingadores Ultimato', type: 'movie', id: 'tt4154796' },
    { name: 'Breaking Bad S1E1', type: 'series', id: 'tt0903747:1:1' },
];

(async () => {
    for (const test of tests) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`TESTE: ${test.name} (${test.id})`);
        console.log('='.repeat(60));
        const t1 = Date.now();
        const streams = await getStreams(test.type, test.id);
        const t2 = Date.now();
        console.log(`\n✅ Resultado: ${streams.length} streams em ${t2 - t1}ms`);
        streams.slice(0, 5).forEach((s, i) => {
            console.log(`  [${i}] ${s.name} - ${s.description} ${s.infoHash ? '(hash:' + s.infoHash.substring(0,12) + '...)' : s.url ? '(URL)' : ''}`);
        });
        if (streams.length > 5) console.log(`  ... e mais ${streams.length - 5} streams`);
    }
    console.log('\n\n🏁 TODOS OS TESTES CONCLUÍDOS');
})().catch(e => console.error('FATAL:', e.message));
