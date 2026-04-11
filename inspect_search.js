const axios = require('axios');
const fs = require('fs');

async function saveSearchHTML() {
    try {
        const res = await axios.get('https://ytsbr.com/search/?q=Matrix', { headers: { 'User-Agent': 'Mozilla/5.0' }});
        fs.writeFileSync('matrix_search.html', res.data);
        console.log('Saved Matrix search HTML');
    } catch (e) {
        console.log('Error:', e.message);
    }
}
saveSearchHTML();
