const OpenAI = require("openai");
const axios = require("axios");

// ============================================
// AI-POWERED BLOG DISCOVERY
// Uses OpenAI SDK with web_search tool (same pattern as aiService.js)
// ============================================

function safeDecodeSlug(url) {
    try {
        const slug = url.split("/").filter(Boolean).pop() || "";
        return decodeURIComponent(slug.replace(/-/g, " ").replace(/\.\w+$/, ""));
    } catch {
        return url;
    }
}

function extractJson(text) {
    if (!text) return null;
    const cleaned = text.replace(/```json|```/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

// ============================================
// STRATEGY 1: OpenAI with Web Search (using SDK)
// ============================================
async function findBlogsWithOpenAI(domain, limit) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("[Blog] No OPENAI_API_KEY, skipping OpenAI");
        return [];
    }

    try {
        console.log(`[Blog] Using OpenAI web search to find blogs for ${domain}...`);
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const response = await openai.responses.create({
            model: "gpt-4o",
            tools: [{ type: "web_search" }],
            input: `Find ${limit} REAL blog posts or articles published on the website ${domain}.

Use web search to find: site:${domain} blog OR article OR post

Return ONLY actual URLs you find in the search results. Do NOT invent or fabricate any URLs.

Respond with JSON:
{
    "blogPosts": [
        {"url": "actual URL from search", "title": "article title", "description": "brief summary"}
    ]
}

If no blog posts found, return: {"blogPosts": []}`
        });

        const content = response.output_text || "";
        console.log(`[Blog] OpenAI response: ${content.substring(0, 200)}...`);

        const parsed = extractJson(content);
        if (parsed?.blogPosts?.length > 0) {
            console.log(`[Blog] OpenAI found ${parsed.blogPosts.length} blog posts`);
            return parsed.blogPosts.map((p, i) => ({
                id: i + 1,
                url: p.url,
                title: p.title || safeDecodeSlug(p.url),
                date: p.date || null,
                description: p.description || "",
                image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
            }));
        }

        console.log("[Blog] OpenAI found no blogs");
        return [];
    } catch (error) {
        console.log(`[Blog] OpenAI failed: ${error.message}`);
        return [];
    }
}

// ============================================
// STRATEGY 2: Sitemap/Blog Page Scraping (Fallback)
// ============================================
async function findBlogsFromScraping(domain, limit) {
    const urls = new Set();
    console.log(`[Blog] Fallback: Scraping ${domain} for blog URLs...`);

    // Try sitemaps
    const sitemapPaths = ["/sitemap.xml", "/post-sitemap.xml", "/blog-sitemap.xml"];
    for (const path of sitemapPaths) {
        try {
            const { data } = await axios.get(`https://${domain}${path}`, {
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BTABot/1.0)' }
            });

            const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
            for (const m of matches) {
                const url = m.replace(/<\/?loc>/gi, "");
                const pathname = new URL(url).pathname;
                // Keep URLs with slugs (paths > 1 segment or long single segment)
                if (pathname.split("/").filter(Boolean).length >= 1 &&
                    (pathname.includes("-") || pathname.length > 20)) {
                    urls.add(url);
                }
            }

            if (urls.size > 0) {
                console.log(`[Blog] Sitemap found ${urls.size} URLs`);
                break;
            }
        } catch { }
    }

    // Try blog pages if sitemap failed
    if (urls.size === 0) {
        const blogPaths = ["/blog", "/resources", "/insights", "/news"];
        for (const path of blogPaths) {
            try {
                const { data } = await axios.get(`https://${domain}${path}`, {
                    timeout: 8000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BTABot/1.0)' }
                });

                const hrefMatches = data.match(/href="([^"]+)"/gi) || [];
                for (const m of hrefMatches) {
                    const href = m.replace(/href="|"/gi, "");
                    let fullUrl = href.startsWith("http") ? href :
                        href.startsWith("/") ? `https://${domain}${href}` : null;

                    if (fullUrl && fullUrl.includes(domain) &&
                        new URL(fullUrl).pathname.split("/").filter(Boolean).length >= 2) {
                        urls.add(fullUrl);
                    }
                }

                if (urls.size > 0) {
                    console.log(`[Blog] Found ${urls.size} URLs from ${path}`);
                    break;
                }
            } catch { }
        }
    }

    return [...urls].slice(0, limit).map((url, i) => ({
        id: i + 1,
        url,
        title: safeDecodeSlug(url),
        date: null,
        description: "",
        image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
    }));
}

// ============================================
// VERIFY URLs are accessible (HEAD check)
// ============================================
async function verifyUrls(posts) {
    if (posts.length === 0) return [];

    console.log(`[Blog] Verifying ${posts.length} URLs...`);
    const verified = [];

    for (const post of posts) {
        try {
            await axios.head(post.url, {
                timeout: 5000,
                maxRedirects: 3,
                validateStatus: (s) => s >= 200 && s < 400
            });
            verified.push(post);
        } catch {
            console.log(`[Blog] Skipped (not accessible): ${post.url}`);
        }
    }

    console.log(`[Blog] Verified ${verified.length}/${posts.length} URLs`);
    return verified;
}

// ============================================
// MAIN: AI first, then scraping fallback
// ============================================
async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] ═══ Finding blog posts for: ${domain} ═══`);

    let posts = [];

    // Try OpenAI with web search first
    posts = await findBlogsWithOpenAI(domain, limit);

    // Fallback to scraping if AI failed
    if (posts.length === 0) {
        posts = await findBlogsFromScraping(domain, limit);
    }

    // Verify URLs exist
    if (posts.length > 0) {
        posts = await verifyUrls(posts);
    }

    if (posts.length === 0) {
        console.log(`[Blog] No blog posts found for ${domain}`);
        return [];
    }

    console.log(`[Blog] Returning ${posts.length} blog posts`);
    return posts;
}

module.exports = { getBlogPosts };
