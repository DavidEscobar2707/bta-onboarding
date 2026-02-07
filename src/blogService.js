const axios = require("axios");

// ============================================
// Helpers
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
// STEP 1: SCRAPE - Find blog URLs from sitemap & blog pages (NO AI)
// ============================================
async function scrapeBlogUrls(domain, limit) {
    const urls = new Set();

    // Try sitemaps first
    const sitemapPaths = ["/sitemap.xml", "/post-sitemap.xml", "/blog-sitemap.xml", "/sitemap_index.xml"];
    for (const sitemapPath of sitemapPaths) {
        try {
            const { data } = await axios.get(`https://${domain}${sitemapPath}`, { timeout: 8000 });
            const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
            for (const m of matches) {
                const url = m.replace(/<\/?loc>/gi, "");
                if (/\/(blog|post|article|news|insight|resource|update|story|case-stud)/i.test(url) &&
                    !url.endsWith("/blog") && !url.endsWith("/blog/") &&
                    !url.includes("?page=") && !url.includes("/category/") && !url.includes("/tag/")) {
                    urls.add(url);
                }
            }
            if (urls.size > 0) {
                console.log(`[Blog] Found ${urls.size} URLs from ${sitemapPath}`);
                break;
            }
        } catch {
            // sitemap not found
        }
    }

    // If sitemap failed, try scraping blog listing pages
    if (urls.size === 0) {
        const blogPaths = ["/blog", "/resources", "/insights", "/news", "/articles"];
        for (const blogPath of blogPaths) {
            try {
                const { data } = await axios.get(`https://${domain}${blogPath}`, { timeout: 8000 });
                // Find links that look like blog posts
                const linkMatches = data.match(/href="(\/[^"]*(?:blog|post|article|news|insight)[^"]*?)"/gi) || [];
                for (const m of linkMatches) {
                    const href = m.match(/href="([^"]+)"/)?.[1];
                    if (href && href !== blogPath && href !== `${blogPath}/` && href.split("/").length > 2) {
                        const fullUrl = href.startsWith("http") ? href : `https://${domain}${href}`;
                        urls.add(fullUrl);
                    }
                }
                if (urls.size > 0) {
                    console.log(`[Blog] Found ${urls.size} URLs from ${blogPath} page`);
                    break;
                }
            } catch {
                // page not found
            }
        }
    }

    return [...urls].slice(0, limit);
}

// ============================================
// STEP 2: VERIFY - HTTP HEAD check to confirm URLs are live
// ============================================
async function verifyUrls(urls) {
    const verified = [];
    const checks = urls.map(async (url) => {
        try {
            const res = await axios.head(url, { timeout: 5000, maxRedirects: 3 });
            if (res.status >= 200 && res.status < 400) {
                verified.push(url);
            }
        } catch {
            // URL doesn't resolve
        }
    });
    await Promise.all(checks);
    console.log(`[Blog] Verified ${verified.length}/${urls.length} URLs are live`);
    return verified;
}

// ============================================
// STEP 3: ENRICH - Extract metadata with OpenAI (fallback to slug titles)
// ============================================
async function enrichWithOpenAI(urls) {
    const openaiKey = process.env.OPENAI_API_KEY;

    // If no OpenAI key, return basic metadata from URL slugs
    if (!openaiKey || urls.length === 0) {
        console.log("[Blog] No OpenAI key or no URLs, using slug-based titles");
        return urls.map((url, i) => ({
            id: i + 1,
            url,
            title: safeDecodeSlug(url),
            date: null,
            description: "",
            body: "",
            image: `https://picsum.photos/seed/blog-${i + 1}/800/400`,
        }));
    }

    try {
        console.log(`[Blog] Enriching ${urls.length} URLs with OpenAI...`);

        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You extract metadata from blog URLs. For each URL, infer the title from the slug, estimate a plausible date, and write a brief description. Respond ONLY with valid JSON."
                    },
                    {
                        role: "user",
                        content: `Extract metadata for these blog post URLs:\n\n${urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n\nRespond with JSON:\n{"blogPosts": [{"url": "...", "title": "...", "date": "YYYY-MM-DD or null", "description": "2-3 sentence summary based on the slug/URL"}]}`
                    }
                ],
                temperature: 0.3,
                max_tokens: 2000
            },
            {
                headers: {
                    "Authorization": `Bearer ${openaiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        const content = response.data.choices?.[0]?.message?.content || "";
        const parsed = extractJson(content);

        if (!parsed || !Array.isArray(parsed.blogPosts)) {
            console.log("[Blog] OpenAI response not parseable, using slug titles");
            return urls.map((url, i) => ({
                id: i + 1,
                url,
                title: safeDecodeSlug(url),
                date: null,
                description: "",
                body: "",
                image: `https://picsum.photos/seed/blog-${i + 1}/800/400`,
            }));
        }

        console.log(`[Blog] OpenAI enriched ${parsed.blogPosts.length} posts`);

        return parsed.blogPosts.map((post, i) => ({
            id: i + 1,
            url: post.url || urls[i],
            title: post.title?.trim() || safeDecodeSlug(urls[i]),
            date: post.date || null,
            description: post.description || "",
            body: post.body || "",
            image: `https://picsum.photos/seed/blog-${i + 1}/800/400`,
        }));

    } catch (error) {
        console.error("[Blog] OpenAI enrichment failed:", error.message);
        return urls.map((url, i) => ({
            id: i + 1,
            url,
            title: safeDecodeSlug(url),
            date: null,
            description: "",
            body: "",
            image: `https://picsum.photos/seed/blog-${i + 1}/800/400`,
        }));
    }
}

// ============================================
// MAIN: Scrape first → Verify → Enrich (NO Gemini dependency)
// ============================================
async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] ═══ Finding blog posts for: ${domain} ═══`);

    // ── Step 1: Scrape URLs from sitemap/blog pages ──
    const scraped = await scrapeBlogUrls(domain, limit);
    console.log(`[Blog] Scraped ${scraped.length} candidate URLs`);

    if (scraped.length === 0) {
        console.log(`[Blog] No blog URLs found for ${domain}`);
        return [];
    }

    // ── Step 2: Verify URLs are live ──
    const liveUrls = await verifyUrls(scraped);
    if (liveUrls.length === 0) {
        console.log("[Blog] None of the scraped URLs are live");
        return [];
    }

    // ── Step 3: Enrich with OpenAI metadata ──
    const posts = await enrichWithOpenAI(liveUrls);
    console.log(`[Blog] Returning ${posts.length} blog posts`);
    return posts;
}

module.exports = { getBlogPosts };
