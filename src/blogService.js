const axios = require("axios");

// ============================================
// AI-POWERED BLOG DISCOVERY
// Uses OpenAI and Gemini with web search to find REAL blog posts
// because every company structures their blogs differently
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

function extractUrls(text) {
    if (!text) return [];
    // Match URLs in the response
    const urlRegex = /https?:\/\/[^\s\"\'\)\]\}]+/gi;
    const matches = text.match(urlRegex) || [];
    // Clean and dedupe
    const cleaned = [...new Set(matches.map(u => u.replace(/[.,;:!?\)\]\}]+$/, '')))];
    return cleaned;
}

// ============================================
// STRATEGY 1: OpenAI with Web Search
// ============================================
async function findBlogsWithOpenAI(domain, limit) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        console.log("[Blog] No OpenAI key, skipping OpenAI search");
        return [];
    }

    try {
        console.log(`[Blog] Searching blogs with OpenAI web search for ${domain}...`);

        const response = await axios.post(
            "https://api.openai.com/v1/responses",
            {
                model: "gpt-4o",
                tools: [{ type: "web_search_preview" }],
                input: `Find ${limit} REAL blog posts or articles published on the website ${domain}. 
                
Search the web for: site:${domain} blog OR article OR post OR news OR insights

Return ONLY URLs that:
1. Are actual blog/article pages on ${domain} (not category pages, not the main blog listing)
2. Actually exist and are accessible right now
3. Have real content (not 404 pages)

Respond with a JSON object:
{
    "blogPosts": [
        {"url": "full URL", "title": "article title", "description": "brief description"}
    ]
}

Do NOT invent URLs. Only return URLs you found in the search results.`
            },
            {
                headers: {
                    "Authorization": `Bearer ${openaiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 45000
            }
        );

        const content = response.data.output?.[0]?.content?.[0]?.text ||
            response.data.choices?.[0]?.message?.content || "";

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

        // Fallback: extract URLs directly from response
        const urls = extractUrls(content).filter(u => u.includes(domain));
        if (urls.length > 0) {
            console.log(`[Blog] OpenAI found ${urls.length} URLs (extracted from text)`);
            return urls.slice(0, limit).map((url, i) => ({
                id: i + 1,
                url,
                title: safeDecodeSlug(url),
                date: null,
                description: "",
                image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
            }));
        }

        return [];
    } catch (error) {
        console.log(`[Blog] OpenAI search failed: ${error.message}`);
        return [];
    }
}

// ============================================
// STRATEGY 2: Gemini with Google Search
// ============================================
async function findBlogsWithGemini(domain, limit) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        console.log("[Blog] No Gemini key, skipping Gemini search");
        return [];
    }

    try {
        console.log(`[Blog] Searching blogs with Gemini + Google Search for ${domain}...`);

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
                contents: [{
                    parts: [{
                        text: `Find ${limit} REAL blog posts or articles published on ${domain}.

Search for: site:${domain} blog OR article OR insights OR resources

I need actual, existing URLs - not invented ones. Return a JSON object with the real blog post URLs you find:

{
    "blogPosts": [
        {"url": "actual URL from ${domain}", "title": "article title", "description": "what it's about"}
    ]
}

Only include URLs that definitely exist on ${domain}. Do not make up URLs.`
                    }]
                }],
                tools: [{
                    googleSearch: {}
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 2000
                }
            },
            { timeout: 45000 }
        );

        const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        const parsed = extractJson(content);
        if (parsed?.blogPosts?.length > 0) {
            console.log(`[Blog] Gemini found ${parsed.blogPosts.length} blog posts`);
            return parsed.blogPosts.map((p, i) => ({
                id: i + 1,
                url: p.url,
                title: p.title || safeDecodeSlug(p.url),
                date: p.date || null,
                description: p.description || "",
                image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
            }));
        }

        // Fallback: extract URLs
        const urls = extractUrls(content).filter(u => u.includes(domain));
        if (urls.length > 0) {
            console.log(`[Blog] Gemini found ${urls.length} URLs (extracted)`);
            return urls.slice(0, limit).map((url, i) => ({
                id: i + 1,
                url,
                title: safeDecodeSlug(url),
                date: null,
                description: "",
                image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
            }));
        }

        return [];
    } catch (error) {
        console.log(`[Blog] Gemini search failed: ${error.message}`);
        return [];
    }
}

// ============================================
// STRATEGY 3: Sitemap Fallback (quick check)
// ============================================
async function findBlogsFromSitemap(domain, limit) {
    const urls = [];
    const sitemapPaths = ["/sitemap.xml", "/post-sitemap.xml", "/blog-sitemap.xml"];

    for (const path of sitemapPaths) {
        try {
            const { data } = await axios.get(`https://${domain}${path}`, { timeout: 5000 });
            const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];

            for (const m of matches) {
                const url = m.replace(/<\/?loc>/gi, "");
                // Only get URLs with blog-like patterns OR articles in path
                if ((url.includes('/blog/') || url.includes('/post/') ||
                    url.includes('/article') || url.includes('/insights/') ||
                    url.includes('/resources/') || url.includes('/news/')) &&
                    !url.endsWith("/blog") && !url.endsWith("/blog/") &&
                    !url.includes("/category/") && !url.includes("/tag/") &&
                    !url.includes("?page=")) {
                    urls.push(url);
                }
            }

            if (urls.length > 0) {
                console.log(`[Blog] Sitemap found ${urls.length} blog URLs`);
                break;
            }
        } catch {
            // sitemap not found
        }
    }

    return urls.slice(0, limit).map((url, i) => ({
        id: i + 1,
        url,
        title: safeDecodeSlug(url),
        date: null,
        description: "",
        image: `https://picsum.photos/seed/blog-${i + 1}/800/400`
    }));
}

// ============================================
// VERIFY URLs are actually accessible
// ============================================
async function verifyUrls(posts) {
    if (posts.length === 0) return [];

    console.log(`[Blog] Verifying ${posts.length} URLs...`);
    const verified = [];

    for (const post of posts) {
        try {
            const res = await axios.head(post.url, {
                timeout: 5000,
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 400
            });
            verified.push(post);
        } catch {
            console.log(`[Blog] Skipped (not accessible): ${post.url}`);
        }
    }

    console.log(`[Blog] Verified ${verified.length}/${posts.length} URLs are accessible`);
    return verified;
}

// ============================================
// MAIN: Try AI search first, then sitemap fallback
// ============================================
async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] ═══ Finding blog posts for: ${domain} ═══`);

    let posts = [];

    // Try OpenAI first (has web search)
    posts = await findBlogsWithOpenAI(domain, limit);

    // If OpenAI failed, try Gemini
    if (posts.length === 0) {
        posts = await findBlogsWithGemini(domain, limit);
    }

    // If AI failed, try sitemap
    if (posts.length === 0) {
        posts = await findBlogsFromSitemap(domain, limit);
    }

    // Verify URLs are accessible
    if (posts.length > 0) {
        posts = await verifyUrls(posts);
    }

    if (posts.length === 0) {
        console.log(`[Blog] No blog posts found for ${domain}`);
        return [];
    }

    console.log(`[Blog] Returning ${posts.length} verified blog posts`);
    return posts;
}

module.exports = { getBlogPosts };
