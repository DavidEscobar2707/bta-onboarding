const OpenAI = require("openai");
const axios = require("axios");
const cheerio = require("cheerio");

// Perplexity client (OpenAI-compatible)
function getPerplexityClient() {
    if (!process.env.PERPLEXITY_API_KEY) return null;
    return new OpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY,
        baseURL: "https://api.perplexity.ai",
    });
}

// ============================================
// AI-POWERED BLOG DISCOVERY + FULL CONTENT SCRAPING
// Finds top 10 most popular/recent blogs and scrapes full content
// ============================================

// URLs to exclude - not actual blog posts
const EXCLUDED_PATTERNS = [
    /sitemap/i,
    /\.xml$/i,
    /\.json$/i,
    /\.pdf$/i,
    /\/tag\//i,
    /\/category\//i,
    /\/author\//i,
    /\/page\/\d+/i,
    /\/feed\//i,
    /\/rss/i,
    /\/wp-content\//i,
    /\/wp-admin\//i,
    /\/wp-includes\//i,
    /\/cdn-cgi\//i,
    /\/assets\//i,
    /\/static\//i,
    /\/#/,
    /\/search/i,
    /\/login/i,
    /\/signup/i,
    /\/register/i,
    /\/cart/i,
    /\/checkout/i,
    /\/account/i,
    /\/privacy/i,
    /\/terms/i,
    /\/contact$/i,
    /\/about$/i,
    /\/pricing$/i,
    /\/features$/i,
    /\/demo$/i
];

function isValidBlogUrl(url) {
    // Must have a path with at least one slug segment
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname;

        // Check against excluded patterns
        for (const pattern of EXCLUDED_PATTERNS) {
            if (pattern.test(url)) {
                return false;
            }
        }

        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 0) return false;

        const lastSegment = segments[segments.length - 1];

        // If path contains blog/article/post indicator, be more lenient
        const blogIndicators = ['blog', 'post', 'posts', 'article', 'articles', 'news', 'insights', 'resources',
            'knowledge-base', 'learn', 'thoughts', 'library', 'guides', 'stories', 'updates', 'journal', 'content', 'ideas', 'writing'];
        const hasBlogIndicator = segments.some(s => blogIndicators.includes(s.toLowerCase()));

        // If we have a blog indicator and at least one more segment, accept it
        if (hasBlogIndicator && segments.length >= 2) {
            // Last segment should look like a slug (has dash, underscore, or >5 chars)
            if (lastSegment.includes('-') || lastSegment.includes('_') || lastSegment.length > 5) {
                return true;
            }
        }

        // For URLs with 2+ segments, accept if last segment looks like content slug
        if (segments.length >= 2) {
            if (lastSegment.includes('-') || lastSegment.length > 15) {
                return true;
            }
        }

        // Accept any path with a meaningful slug (contains dash and is reasonably long)
        if (lastSegment.includes('-') && lastSegment.length > 8) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

function safeDecodeSlug(url) {
    try {
        const slug = url.split("/").filter(Boolean).pop() || "";
        // Clean up the slug to make it a readable title
        const decoded = decodeURIComponent(slug)
            .replace(/-/g, " ")
            .replace(/\.\w+$/, "")
            .replace(/[_]/g, " ");

        // Capitalize first letter of each word
        return decoded.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    } catch {
        return "Untitled Article";
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

function normalizeUrl(url) {
    try {
        if (!url) return '';
        // Ensure protocol
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        const parsed = new URL(url);

        // Remove 'www.' and lowercase
        let hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();

        // Remove trailing slash from pathname, lowercase for consistent comparison
        let pathname = parsed.pathname.toLowerCase();
        if (pathname.endsWith('/') && pathname.length > 1) {
            pathname = pathname.slice(0, -1);
        }

        // Return normalized string (ignore hash/search for blog identity usually)
        return `${parsed.protocol}//${hostname}${pathname}`;
    } catch {
        return url;
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
        $('script, style, nav, header, footer, aside, .sidebar, .comments, .related-posts, .advertisement, .ad, .social-share, .cookie-banner, .popup, .modal').remove();

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
            '.blog-post-content',
            '.single-post-content',
            '.article-body',
            'main article',
            'main .content',
            'main'
        ];

        let content = '';
        let title = $('h1').first().text().trim() ||
            $('meta[property="og:title"]').attr('content') ||
            $('title').text().trim().split('|')[0].trim();
        let description = $('meta[name="description"]').attr('content') ||
            $('meta[property="og:description"]').attr('content') || '';
        let author = $('meta[name="author"]').attr('content') ||
            $('[rel="author"]').text().trim() ||
            $('.author-name, .byline, .post-author, .author').first().text().trim() || '';
        let publishDate = $('meta[property="article:published_time"]').attr('content') ||
            $('time').attr('datetime') ||
            $('[class*="date"], [class*="published"]').first().text().trim() || '';
        let image = $('meta[property="og:image"]').attr('content') ||
            $('article img').first().attr('src') ||
            $('.featured-image img, .post-thumbnail img').first().attr('src') || '';

        // Make image URL absolute if relative
        if (image && !image.startsWith('http')) {
            try {
                const baseUrl = new URL(url);
                image = new URL(image, baseUrl.origin).href;
            } catch { }
        }

        // Try each selector to find content
        for (const selector of contentSelectors) {
            const element = $(selector);
            if (element.length > 0) {
                // Get text content, preserving some structure
                content = element
                    .find('p, h2, h3, h4, li, blockquote')
                    .map((i, el) => $(el).text().trim())
                    .get()
                    .filter(text => text.length > 30) // Filter out short fragments
                    .join('\n\n');

                if (content.length > 300) break;
            }
        }

        // Fallback: get all paragraphs
        if (content.length < 300) {
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

        // Only return if we got meaningful content
        if (content.length < 100 || wordCount < 20) {
            console.log(`[Blog] Insufficient content from ${url}`);
            return null;
        }

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
// STRATEGY 1: Perplexity with Web Search - Find TOP 10 popular/recent
// ============================================
async function findBlogsWithPerplexity(domain, limit = 10) {
    const client = getPerplexityClient();
    if (!client) {
        console.log("[Blog] No PERPLEXITY_API_KEY, skipping Perplexity");
        return [];
    }

    try {
        console.log(`[Blog] Using Perplexity web search to find top ${limit} blogs for ${domain}...`);

        const response = await client.chat.completions.create({
            model: "sonar",
            messages: [
                {
                    role: "system",
                    content: "You are a blog discovery assistant. Search the web and return ONLY valid JSON. No markdown wrapping."
                },
                {
                    role: "user",
                    content: `Find ${limit} REAL blog posts or articles published on ${domain}.

Search for: site:${domain}/blog OR site:${domain}/resources OR site:${domain}/insights

IMPORTANT:
- Return ONLY actual article/blog post URLs (not category pages, tag pages, or sitemaps)
- URLs should be individual articles with slugs like "/blog/article-name"
- Do NOT include URLs ending in /blog/, /resources/, /category/, /tag/, /author/

For each REAL article found:
- The exact full URL
- The article title
- A brief description of what the article is about

Respond with JSON:
{
    "blogPosts": [
        {
            "url": "https://${domain}/blog/example-article-title",
            "title": "Example Article Title",
            "description": "Brief description of the article content"
        }
    ]
}

If no blog posts found, return: {"blogPosts": []}`
                }
            ],
        });

        const content = response.choices?.[0]?.message?.content || "";
        console.log(`[Blog] Perplexity response received`);

        const parsed = extractJson(content);
        if (parsed?.blogPosts?.length > 0) {
            // Filter valid URLs
            const validPosts = parsed.blogPosts.filter(p => isValidBlogUrl(p.url));
            console.log(`[Blog] Perplexity found ${validPosts.length} valid blog posts (filtered from ${parsed.blogPosts.length})`);

            return validPosts.slice(0, limit).map((p, i) => ({
                id: i + 1,
                url: p.url,
                title: p.title || safeDecodeSlug(p.url),
                date: p.date || null,
                description: p.description || "",
                popularity: p.popularity || "medium",
                image: null // Will be scraped later
            }));
        }

        console.log("[Blog] Perplexity found no blogs");
        return [];
    } catch (error) {
        console.log(`[Blog] Perplexity failed: ${error.message}`);
        return [];
    }
}

// ============================================
// STRATEGY 2: Direct Blog Page Scraping (Fallback)
// ============================================
async function findBlogsFromScraping(domain, limit = 10) {
    const urls = new Set();
    console.log(`[Blog] Fallback: Scraping ${domain} for blog URLs...`);

    // Try blog listing pages directly (not sitemaps)
    const blogPaths = [
        "/blog", "/resources", "/insights", "/news", "/articles", "/posts",
        "/knowledge-base", "/learn", "/thoughts", "/library", "/guides",
        "/stories", "/updates", "/journal", "/content", "/ideas", "/writing"
    ];

    for (const path of blogPaths) {
        try {
            console.log(`[Blog] Trying ${domain}${path}...`);
            const { data } = await axios.get(`https://${domain}${path}`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            const $ = cheerio.load(data);

            // Find article links - look for common patterns
            const linkSelectors = [
                'article a[href]',
                '.post a[href]',
                '.blog-post a[href]',
                '.article-card a[href]',
                '.entry-title a[href]',
                'h2 a[href]',
                'h3 a[href]',
                '.card a[href]',
                'a[href*="/blog/"]',
                'a[href*="/post/"]',
                'a[href*="/article/"]'
            ];

            for (const selector of linkSelectors) {
                $(selector).each((i, el) => {
                    let href = $(el).attr('href');
                    if (!href) return;

                    // Make URL absolute
                    if (href.startsWith('/')) {
                        href = `https://${domain}${href}`;
                    } else if (!href.startsWith('http')) {
                        return;
                    }

                    // Only include URLs from the same domain
                    try {
                        const parsed = new URL(href);
                        if (!parsed.hostname.includes(domain.replace('www.', ''))) return;
                    } catch {
                        return;
                    }

                    // Validate it's a real blog URL
                    if (isValidBlogUrl(href)) {
                        urls.add(href);
                    }
                });
            }

            if (urls.size >= limit) {
                console.log(`[Blog] Found ${urls.size} valid blog URLs from ${path}`);
                break;
            }
        } catch (error) {
            console.log(`[Blog] Could not access ${domain}${path}: ${error.message}`);
        }
    }

    // Try sitemaps - this is actually more reliable than scraping
    if (urls.size < limit) {
        console.log("[Blog] Trying sitemaps for blog URLs...");
        const sitemapPaths = [
            "/sitemap.xml",           // Main sitemap (often has index to other sitemaps)
            "/sitemap_index.xml",     // Alternative index
            "/post-sitemap.xml",      // WordPress post sitemap
            "/blog-sitemap.xml",      // Custom blog sitemap
            "/pages-sitemap.xml"      // Sometimes blogs are in pages
        ];

        for (const path of sitemapPaths) {
            try {
                const { data } = await axios.get(`https://${domain}${path}`, {
                    timeout: 8000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });

                // Check if this is a sitemap index (contains other sitemaps)
                const sitemapRefs = data.match(/<loc>(https?:\/\/[^<]+sitemap[^<]*\.xml)<\/loc>/gi) || [];

                // If it's an index, fetch the child sitemaps too
                for (const ref of sitemapRefs.slice(0, 3)) { // Limit to 3 child sitemaps
                    const childUrl = ref.replace(/<\/?loc>/gi, "");
                    const contentKeywords = ['blog', 'post', 'article', 'news', 'insight', 'resource', 'page', 'content'];
                    if (contentKeywords.some(kw => childUrl.toLowerCase().includes(kw))) {
                        try {
                            console.log(`[Blog] Fetching child sitemap: ${childUrl}`);
                            const childRes = await axios.get(childUrl, { timeout: 8000 });
                            const childMatches = childRes.data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
                            for (const m of childMatches) {
                                const url = m.replace(/<\/?loc>/gi, "");
                                if (isValidBlogUrl(url)) {
                                    urls.add(url);
                                }
                            }
                        } catch { }
                    }
                }

                // Also check direct URLs in this sitemap
                const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
                for (const m of matches) {
                    const url = m.replace(/<\/?loc>/gi, "");
                    // Skip sitemap references themselves
                    if (url.endsWith('.xml')) continue;
                    // Use our validation to check if it's a blog-like URL
                    if (isValidBlogUrl(url)) {
                        urls.add(url);
                    }
                }

                if (urls.size >= limit) {
                    console.log(`[Blog] Sitemap found ${urls.size} valid URLs`);
                    break;
                }
            } catch (err) {
                // Silently continue to next sitemap
            }
        }

        if (urls.size > 0) {
            console.log(`[Blog] Sitemaps found total of ${urls.size} valid URLs`);
        }
    }

    console.log(`[Blog] Total valid blog URLs found: ${urls.size}`);

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
            const response = await axios.head(post.url, {
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

    // STRATEGY 1: Direct scraping + Sitemap (most reliable)
    // This actually crawls the site and finds real URLs
    console.log("[Blog] Step 1: Crawling site and sitemaps for blog URLs...");
    posts = await findBlogsFromScraping(domain, limit);
    console.log(`[Blog] Scraping found ${posts.length} blog posts`);

    // STRATEGY 2: Perplexity web search (fallback for additional posts)
    // Only if we found too few posts from scraping
    if (posts.length < 8) {
        console.log("[Blog] Step 2: Trying Perplexity web search to find more posts...");
        const aiPosts = await findBlogsWithPerplexity(domain, limit);

        if (aiPosts.length > 0) {
            // Merge, avoiding duplicates (use normalized URLs for comparison)
            const existingUrls = new Set(posts.map(p => normalizeUrl(p.url)));
            for (const post of aiPosts) {
                if (!existingUrls.has(normalizeUrl(post.url))) {
                    existingUrls.add(normalizeUrl(post.url));
                    posts.push(post);
                }
            }
            console.log(`[Blog] After Perplexity merge: ${posts.length} total posts`);
        }
    }

    // Verify URLs exist
    if (posts.length > 0) {
        posts = await verifyUrls(posts);
    }

    // Deduplicate based on normalized URLs
    const uniquePosts = [];
    const seenUrls = new Set();

    for (const post of posts) {
        const normalized = normalizeUrl(post.url);
        if (!seenUrls.has(normalized)) {
            seenUrls.add(normalized);
            uniquePosts.push(post);
        }
    }
    // Reassign sequential IDs after deduplication
    posts = uniquePosts.map((post, i) => ({ ...post, id: i + 1 }));

    // Limit to top 10
    posts = posts.slice(0, 10);

    // Scrape full content for each post
    if (posts.length > 0) {
        console.log(`[Blog] Scraping full content for ${posts.length} posts...`);

        const postsWithContent = [];
        for (let i = 0; i < posts.length; i++) {
            const scraped = await scrapeFullBlogContent(posts[i].url);
            if (scraped && scraped.content) {
                postsWithContent.push({
                    ...posts[i],
                    title: scraped.title || posts[i].title,
                    description: scraped.description || posts[i].description,
                    content: scraped.content,
                    fullContent: scraped.fullContent,
                    author: scraped.author,
                    date: scraped.publishDate || posts[i].date,
                    image: scraped.image || `https://picsum.photos/seed/blog-${i + 1}/800/400`,
                    wordCount: scraped.wordCount,
                    readingTime: scraped.readingTime,
                    scrapedAt: scraped.scrapedAt
                });
            } else {
                // Still include post but with placeholder content
                postsWithContent.push({
                    ...posts[i],
                    image: `https://picsum.photos/seed/blog-${i + 1}/800/400`,
                    content: "Content could not be scraped from this page.",
                    wordCount: 0,
                    readingTime: 0
                });
            }
        }
        posts = postsWithContent;
    }

    if (posts.length === 0) {
        console.log(`[Blog] No blog posts found for ${domain}`);
        return [];
    }

    console.log(`[Blog] ═══ Returning ${posts.length} blog posts with content ═══`);
    return posts;
}

module.exports = { getBlogPosts, scrapeFullBlogContent };
