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
// STEP 2: VERIFY - GET request with content validation
// ============================================
async function verifyUrls(urls) {
    const verified = [];

    // Process in smaller batches to avoid overwhelming servers
    const batchSize = 5;
    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const checks = batch.map(async (url) => {
            try {
                const res = await axios.get(url, {
                    timeout: 8000,
                    maxRedirects: 3,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    // Only get first 50KB to check content
                    maxContentLength: 50000,
                    validateStatus: (status) => status >= 200 && status < 400
                });

                const html = res.data || "";
                const finalUrl = res.request?.res?.responseUrl || url;

                // Check if redirected to homepage (bad sign)
                const urlPath = new URL(url).pathname;
                const finalPath = new URL(finalUrl).pathname;
                if (urlPath !== finalPath && (finalPath === "/" || finalPath === "")) {
                    console.log(`[Blog] Skipped (redirect to homepage): ${url}`);
                    return;
                }

                // Check for 404/error indicators in content
                const lowerHtml = html.toLowerCase();
                const is404Page =
                    lowerHtml.includes("page not found") ||
                    lowerHtml.includes("404") ||
                    lowerHtml.includes("no longer available") ||
                    lowerHtml.includes("this page doesn't exist") ||
                    lowerHtml.includes("we couldn't find");

                if (is404Page) {
                    console.log(`[Blog] Skipped (soft 404): ${url}`);
                    return;
                }

                // Check for minimum content (actual article should have some text)
                const hasContent = html.length > 2000 && (
                    lowerHtml.includes("<article") ||
                    lowerHtml.includes("class=\"post") ||
                    lowerHtml.includes("class=\"blog") ||
                    lowerHtml.includes("class=\"content") ||
                    lowerHtml.includes("<p>")
                );

                if (!hasContent) {
                    console.log(`[Blog] Skipped (no content): ${url}`);
                    return;
                }

                verified.push(url);
            } catch (err) {
                // URL doesn't resolve or error
                console.log(`[Blog] Skipped (error): ${url} - ${err.message}`);
            }
        });
        await Promise.all(checks);
    }

    console.log(`[Blog] Verified ${verified.length}/${urls.length} URLs are live with content`);
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
                        content: "You extract metadata from blog URLs. For each URL, create a readable title from the slug. Do NOT invent or fabricate dates, statistics, or numbers - only use what is literally in the URL. If no date is visible in the URL, set date to null. Write a brief description based ONLY on what the slug suggests. Respond ONLY with valid JSON."
                    },
                    {
                        role: "user",
                        content: `Extract metadata for these blog post URLs:\n\n${urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n\nRespond with JSON:\n{"blogPosts": [{"url": "...", "title": "...", "date": "YYYY-MM-DD if visible in URL, otherwise null", "description": "1-2 sentence summary based ONLY on the slug - do NOT invent numbers or statistics"}]}`
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
