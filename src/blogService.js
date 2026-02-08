const OpenAI = require("openai");
const axios = require("axios");
const cheerio = require("cheerio");

// ============================================
// AI-POWERED BLOG DISCOVERY + FULL CONTENT SCRAPING
// Finds top 10 most popular/recent blogs and scrapes full content
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
// SCRAPE FULL BLOG CONTENT
// ============================================
async function scrapeFullBlogContent(url) {
    try {
        console.log(`[Blog] Scraping full content: ${url}`);
        const { data } = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);

        // Remove unwanted elements
        $('script, style, nav, header, footer, aside, .sidebar, .comments, .related-posts, .advertisement, .ad, .social-share').remove();

        // Try to find article content in common containers
        const contentSelectors = [
            'article',
            '[role="article"]',
            '.post-content',
            '.article-content',
            '.entry-content',
            '.blog-content',
            '.content-body',
            '.post-body',
            'main',
            '.main-content'
        ];

        let content = '';
        let title = $('h1').first().text().trim() || $('title').text().trim();
        let description = $('meta[name="description"]').attr('content') || '';
        let author = $('meta[name="author"]').attr('content') ||
            $('[rel="author"]').text().trim() ||
            $('.author-name, .byline, .post-author').first().text().trim() || '';
        let publishDate = $('meta[property="article:published_time"]').attr('content') ||
            $('time').attr('datetime') ||
            $('[class*="date"], [class*="published"]').first().text().trim() || '';
        let image = $('meta[property="og:image"]').attr('content') ||
            $('article img').first().attr('src') || '';

        // Try each selector to find content
        for (const selector of contentSelectors) {
            const element = $(selector);
            if (element.length > 0) {
                // Get text content, preserving some structure
                content = element
                    .find('p, h2, h3, h4, li, blockquote')
                    .map((i, el) => $(el).text().trim())
                    .get()
                    .filter(text => text.length > 20) // Filter out short fragments
                    .join('\n\n');

                if (content.length > 200) break;
            }
        }

        // Fallback: get all paragraphs
        if (content.length < 200) {
            content = $('p')
                .map((i, el) => $(el).text().trim())
                .get()
                .filter(text => text.length > 50)
                .slice(0, 30) // Limit paragraphs
                .join('\n\n');
        }

        // Clean up content
        content = content
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n\n')
            .trim();

        // Estimate reading time (average 200 words per minute)
        const wordCount = content.split(/\s+/).length;
        const readingTime = Math.ceil(wordCount / 200);

        console.log(`[Blog] Scraped ${content.length} chars, ${wordCount} words from ${url}`);

        return {
            title: title.substring(0, 300),
            description: description.substring(0, 500),
            content: content.substring(0, 10000), // Limit to 10k chars
            fullContent: content, // Full content for storage
            author,
            publishDate,
            image,
            wordCount,
            readingTime,
            scrapedAt: new Date().toISOString()
        };
    } catch (error) {
        console.log(`[Blog] Failed to scrape ${url}: ${error.message}`);
        return null;
    }
}

// ============================================
// STRATEGY 1: OpenAI with Web Search - Find TOP 10 popular/recent
// ============================================
async function findBlogsWithOpenAI(domain, limit = 10) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("[Blog] No OPENAI_API_KEY, skipping OpenAI");
        return [];
    }

    try {
        console.log(`[Blog] Using OpenAI web search to find top ${limit} blogs for ${domain}...`);
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const response = await openai.responses.create({
            model: "gpt-4o",
            tools: [{ type: "web_search" }],
            input: `Find the TOP ${limit} most popular or most recent blog posts/articles from ${domain}.

Use web search: site:${domain} blog OR article OR post

PRIORITY ORDER:
1. Most shared/popular articles (high engagement, backlinks)
2. Most recent articles (published in the last 6 months)
3. Cornerstone content (comprehensive guides, pillar pages)

For each article, find:
- The exact URL
- The title
- A brief description
- Publication date if visible

Return ONLY real URLs you found. Do NOT fabricate any URLs.

Respond with JSON:
{
    "blogPosts": [
        {
            "url": "actual URL from search",
            "title": "article title",
            "description": "brief summary",
            "date": "publication date or null",
            "popularity": "high|medium|low based on your assessment"
        }
    ]
}

If no posts found, return: {"blogPosts": []}`
        });

        const content = response.output_text || "";
        console.log(`[Blog] OpenAI response received`);

        const parsed = extractJson(content);
        if (parsed?.blogPosts?.length > 0) {
            console.log(`[Blog] OpenAI found ${parsed.blogPosts.length} blog posts`);

            // Sort by popularity (high first) then by date (newest first)
            const sorted = parsed.blogPosts.sort((a, b) => {
                const popOrder = { high: 0, medium: 1, low: 2 };
                const popDiff = (popOrder[a.popularity] || 2) - (popOrder[b.popularity] || 2);
                if (popDiff !== 0) return popDiff;

                // Try to sort by date
                const dateA = new Date(a.date || 0);
                const dateB = new Date(b.date || 0);
                return dateB - dateA;
            });

            return sorted.slice(0, limit).map((p, i) => ({
                id: i + 1,
                url: p.url,
                title: p.title || safeDecodeSlug(p.url),
                date: p.date || null,
                description: p.description || "",
                popularity: p.popularity || "medium",
                image: null // Will be scraped later
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
async function findBlogsFromScraping(domain, limit = 10) {
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
        popularity: "unknown",
        image: null
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
// MAIN: Find top 10 blogs and scrape full content
// ============================================
async function getBlogPosts(domain, limit = 10) {
    console.log(`[Blog] ═══ Finding TOP ${limit} blog posts for: ${domain} ═══`);

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

    // Limit to top 10
    posts = posts.slice(0, 10);

    // Scrape full content for each post
    if (posts.length > 0) {
        console.log(`[Blog] Scraping full content for ${posts.length} posts...`);

        for (let i = 0; i < posts.length; i++) {
            const scraped = await scrapeFullBlogContent(posts[i].url);
            if (scraped) {
                posts[i] = {
                    ...posts[i],
                    title: scraped.title || posts[i].title,
                    description: scraped.description || posts[i].description,
                    content: scraped.content,
                    fullContent: scraped.fullContent,
                    author: scraped.author,
                    date: scraped.publishDate || posts[i].date,
                    image: scraped.image || posts[i].image || `https://picsum.photos/seed/blog-${i + 1}/800/400`,
                    wordCount: scraped.wordCount,
                    readingTime: scraped.readingTime,
                    scrapedAt: scraped.scrapedAt
                };
            }
        }
    }

    if (posts.length === 0) {
        console.log(`[Blog] No blog posts found for ${domain}`);
        return [];
    }

    console.log(`[Blog] ═══ Returning ${posts.length} blog posts with full content ═══`);
    return posts;
}

module.exports = { getBlogPosts, scrapeFullBlogContent };
