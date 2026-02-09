const { getBlogPosts } = require('./src/blogService');
require('dotenv').config();

async function runTest() {
    const domain = 'goliathdata.com';
    console.log(`Testing blog fetching for ${domain}...`);

    try {
        const posts = await getBlogPosts(domain);
        console.log(`\nFound ${posts.length} posts.`);

        const urls = posts.map(p => p.url);
        const uniqueUrls = new Set(urls);

        if (urls.length !== uniqueUrls.size) {
            console.log('❌ Duplicates found!');
            console.log('All URLs:');
            urls.forEach(url => console.log(url));

            // Find specific duplicates
            const seen = new Set();
            const duplicates = new Set();
            for (const url of urls) {
                if (seen.has(url)) {
                    duplicates.add(url);
                }
                seen.add(url);
            }
            console.log('\nDuplicate URLs:', [...duplicates]);
        } else {
            console.log('✅ No duplicates found.');
            urls.forEach(url => console.log(url));
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

runTest();
