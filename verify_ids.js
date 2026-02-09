const { getBlogPosts } = require('./src/blogService');
require('dotenv').config();

async function runTest() {
    const domain = 'goliathdata.com';
    console.log(`Testing blog IDs for ${domain}...`);

    try {
        const posts = await getBlogPosts(domain);
        console.log(`\nFound ${posts.length} posts.`);

        const ids = posts.map(p => p.id);
        const uniqueIds = new Set(ids);

        if (ids.length !== uniqueIds.size) {
            console.log('❌ Duplicate IDs found!');
            console.log('All IDs:', ids);

            // Count occurrences
            const counts = {};
            ids.forEach(id => counts[id] = (counts[id] || 0) + 1);
            Object.entries(counts).forEach(([id, count]) => {
                if (count > 1) console.log(`ID ${id} appears ${count} times`);
            });
        } else {
            console.log('✅ No duplicate IDs found.');
            console.log('IDs:', ids);
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

runTest();
