const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

// ============================================
// STEP 1: Scrape real blog URLs from sitemap + common blog paths
// ============================================
async function scrapeRealBlogUrls(domain, limit) {
    const urls = new Set();

    // Try sitemap.xml first
    for (const sitemapPath of ['/sitemap.xml', '/post-sitemap.xml', '/blog-sitemap.xml', '/sitemap_index.xml']) {
        try {
            const { data } = await axios.get(`https://${domain}${sitemapPath}`, { timeout: 8000 });
            // Extract URLs from XML (simple regex — no XML parser needed)
            const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
            for (const m of matches) {
                const url = m.replace(/<\/?loc>/gi, '');
                // Filter for blog-like URLs
                if (/\/(blog|post|article|news|insight|resource|update|story|case-stud)/i.test(url) && !url.endsWith('/blog') && !url.endsWith('/blog/')) {
                    urls.add(url);
                }
            }
            if (urls.size > 0) {
                console.log(`[Blog] Found ${urls.size} blog URLs from ${sitemapPath}`);
                break;
            }
        } catch { /* sitemap not found, try next */ }
    }

    // If sitemap had nothing, try fetching the /blog page and extracting links
    if (urls.size === 0) {
        for (const blogPath of ['/blog', '/resources', '/insights', '/news', '/articles']) {
            try {
                const { data } = await axios.get(`https://${domain}${blogPath}`, { timeout: 8000 });
                // Extract href links that look like blog posts
                const linkMatches = data.match(/href="(\/[^"]*(?:blog|post|article|news|insight)[^"]*?)"/gi) || [];
                for (const m of linkMatches) {
                    const href = m.match(/href="([^"]+)"/)?.[1];
                    if (href && href !== blogPath && href !== `${blogPath}/` && href.split('/').length > 2) {
                        const fullUrl = href.startsWith('http') ? href : `https://${domain}${href}`;
                        urls.add(fullUrl);
                    }
                }
                if (urls.size > 0) {
                    console.log(`[Blog] Found ${urls.size} blog URLs from ${blogPath} page`);
                    break;
                }
            } catch { /* page not found, try next */ }
        }
    }

    return [...urls].slice(0, limit);
}

// ============================================
// STEP 2: Use AI to enrich scraped URLs with titles/descriptions
// ============================================
async function enrichWithAI(domain, urls) {
    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey || urls.length === 0) {
        // Return basic posts without AI enrichment
        return urls.map((url, i) => ({
            id: i + 1,
            title: decodeURIComponent(url.split('/').pop().replace(/-/g, ' ').replace(/\.\w+$/, '')),
            date: null,
            image: `https://picsum.photos/seed/${i + 1}/800/400`,
            description: '',
            body: '',
            url,
        }));
    }

    try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `I have these REAL blog post URLs from ${domain}. Visit each URL and extract the title, date, and a brief description.

URLs:
${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}

Return ONLY valid JSON:
{
    "blogPosts": [
        {
            "id": 1,
            "title": "The actual title from the page",
            "date": "2024-01-15 or null if not found",
            "description": "Brief summary of the post",
            "body": "First paragraph of the post",
            "url": "the original URL exactly as provided"
        }
    ]
}

RULES:
- Use the EXACT URLs I provided. Do NOT change or invent new URLs.
- Extract real titles from the pages. If you cannot read a page, use the URL slug as title.
- RESPOND ONLY WITH JSON.`,
            config: {
                tools: [{ urlContext: {} }],
            },
        });

        const cleaned = response.text.replace(/```json|```/g, "").trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            // Add images and ensure URLs match
            return (parsed.blogPosts || []).map((post, i) => ({
                ...post,
                id: i + 1,
                image: `https://picsum.photos/seed/${i + 1}/800/400`,
                url: post.url || urls[i],
            }));
        }
    } catch (error) {
        console.error("[Blog] AI enrichment failed:", error.message);
    }

    // Fallback: return posts with URL-derived titles
    return urls.map((url, i) => ({
        id: i + 1,
        title: decodeURIComponent(url.split('/').pop().replace(/-/g, ' ').replace(/\.\w+$/, '')),
        date: null,
        image: `https://picsum.photos/seed/${i + 1}/800/400`,
        description: '',
        body: '',
        url,
    }));
}

// ============================================
// MAIN: Scrape first, enrich second
// ============================================
async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] Finding blog posts for: ${domain}`);

    // Step 1: Get real URLs
    const realUrls = await scrapeRealBlogUrls(domain, limit);
    console.log(`[Blog] Scraped ${realUrls.length} real URLs for ${domain}`);

    if (realUrls.length === 0) {
        console.log(`[Blog] No blog URLs found for ${domain}`);
        return [];
    }

    // Step 2: Enrich with AI (titles, descriptions)
    const posts = await enrichWithAI(domain, realUrls);
    console.log(`[Blog] Returning ${posts.length} enriched blog posts`);
    return posts;
}

module.exports = { getBlogPosts };
