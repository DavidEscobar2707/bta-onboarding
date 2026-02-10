const OpenAI = require("openai");
const axios = require("axios");
const cheerio = require("cheerio");

// Puppeteer for JS-rendered pages (optional, loaded dynamically)
let puppeteer = null;
try {
    puppeteer = require("puppeteer");
} catch {
    console.log("[Blog] Puppeteer not available, using Cheerio only");
}

// ============================================
// AI-POWERED EDITORIAL CONTENT DISCOVERY + FULL CONTENT SCRAPING
// Finds top 10 editorial articles, thought leadership, and guides
// Works even when companies don't have a formal /blog section
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
    /\/demo$/i,
    /\/product/i,           // Product pages
    /\/products/i,          // Product listings
    /\/landing/i,           // Landing pages
    /\/partnerships/i,      // Partnership pages
    /\/partners/i,          // Partner pages
    /\/integrations/i,      // Integration pages
    /\/solutions/i,         // Solution pages
    /\/use-cases/i,         // Use case pages
    /\/case-studies/i,      // Case study pages (different from blog)
    /\/customers/i,         // Customer pages
    /\/company/i,           // Company pages
    /\/careers/i,           // Career pages
    /\/jobs/i,              // Job listings
    /\/events/i,            // Event pages
    /\/webinars/i,          // Webinar pages
    /\/podcasts/i,          // Podcast pages (unless blog format)
    /\/videos/i,            // Video pages
    /\/download/i,          // Download pages
    /\/get-started/i,       // Onboarding pages
    /\/start/i,             // Start pages
    /\/try/i,               // Trial pages
    /\/buy/i,               // Buy pages
    /\/order/i,             // Order pages
    /\/api/i,               // API docs
    /\/docs/i,              // Documentation
    /\/documentation/i,     // Documentation
    /\/help/i,              // Help center
    /\/support/i,           // Support pages
    /\/status/i,            // Status pages
    /\/security/i,          // Security pages
    /\/legal/i,             // Legal pages
    /\/gdpr/i,              // GDPR pages
    /\/ccpa/i,              // CCPA pages
    /\/changelog/i,         // Changelog (different format)
    /\/releases/i,          // Release notes
    /\/roadmap/i            // Roadmap pages
];

/**
 * Check if URL structure indicates it's likely a blog post
 * STRICT mode: Only accept URLs that look like editorial content
 */
function isValidBlogUrl(url, strict = true) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();

        // Check against excluded patterns first
        for (const pattern of EXCLUDED_PATTERNS) {
            if (pattern.test(url)) {
                return false;
            }
        }

        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 0) return false;

        const lastSegment = segments[segments.length - 1];

        // STRICT MODE (default): Only accept URLs with clear blog indicators
        // This avoids product pages, landing pages, etc.
        if (strict) {
            // Must have /blog/, /resources/, /insights/, /articles/, /posts/, /news/, /guides/ in path
            const blogPathIndicators = [
                'blog', 'blogs', 'resources', 'insights', 'articles', 'posts', 
                'news', 'guides', 'stories', 'journal', 'library', 'learn',
                'knowledge-base', 'thoughts', 'content', 'writing', 'updates'
            ];
            
            const hasBlogPath = segments.some(s => blogPathIndicators.includes(s));
            
            if (!hasBlogPath) {
                return false;
            }

            // Must have a meaningful slug after the blog indicator
            // The slug should look like an article title (has dashes, reasonable length)
            if (!lastSegment.includes('-') || lastSegment.length < 10) {
                return false;
            }

            // Extra check: avoid slugs that look like product/feature names
            // (single words or very short phrases without context)
            const wordCount = lastSegment.split('-').length;
            if (wordCount < 3 && lastSegment.length < 20) {
                // Could be a product name like "data-pipelines" or "command-center"
                // Require additional confirmation via hasBlogArticleMetadata
                return 'maybe'; // Needs content validation
            }

            return true;
        }

        // NON-STRICT MODE (fallback): More lenient matching
        // Only use this if we already know the page has blog-like content
        
        // If path contains blog/article/post indicator, be more lenient
        const blogIndicators = ['blog', 'post', 'posts', 'article', 'articles', 'news', 'insights', 'resources',
            'knowledge-base', 'learn', 'thoughts', 'library', 'guides', 'stories', 'updates', 'journal', 'content', 'ideas', 'writing'];
        const hasBlogIndicator = segments.some(s => blogIndicators.includes(s));

        if (hasBlogIndicator && segments.length >= 2) {
            if (lastSegment.includes('-') || lastSegment.length > 5) {
                return true;
            }
        }

        // For URLs with 2+ segments, accept if last segment looks like content slug
        if (segments.length >= 2) {
            if (lastSegment.includes('-') || lastSegment.length > 15) {
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Validate that scraped content looks like a real blog post
 * Returns true if content has blog-like characteristics (date, author, article structure)
 */
function isBlogContent($) {
    // Check for blog-specific HTML structure
    const hasArticleTag = $('article').length > 0;
    const hasBlogPostClass = $('[class*="blog-post"], [class*="post-content"], [class*="article-content"]').length > 0;
    
    // Check for blog metadata
    const hasPublishDate = $('meta[property="article:published_time"], meta[name="publish_date"], time[datetime]').length > 0;
    const hasAuthor = $('meta[name="author"], [rel="author"], .author, .byline').length > 0;
    
    // Check for blog-specific meta tags
    const ogType = $('meta[property="og:type"]').attr('content');
    const isArticle = ogType === 'article';
    
    // Word count check (blogs usually have substantial content)
    const textContent = $('article, .post-content, .entry-content, main').text() || $('body').text();
    const wordCount = textContent.trim().split(/\s+/).length;
    const hasSubstantialContent = wordCount > 300;
    
    // Scoring system
    let score = 0;
    if (hasArticleTag) score += 2;
    if (hasBlogPostClass) score += 2;
    if (hasPublishDate) score += 2;
    if (hasAuthor) score += 1;
    if (isArticle) score += 2;
    if (hasSubstantialContent) score += 1;
    
    // Need at least 3 points to be considered a blog post
    return score >= 3;
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

function isLikelyBlogPost(url) {
    const validation = isValidBlogUrl(url, false);
    if (validation === true) return true;
    if (validation === 'maybe') return true;
    try {
        const parsed = new URL(url);
        const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
        return slug.includes('-') && slug.length >= 12;
    } catch {
        return false;
    }
}

function parsePublishedDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    const cleaned = String(value).trim();
    const normalized = cleaned
        .replace(/(\d{1,2})(st|nd|rd|th)/gi, '$1')
        .replace(/\s+/g, ' ');
    const parsedNormalized = new Date(normalized);
    if (!Number.isNaN(parsedNormalized.getTime())) return parsedNormalized;
    return null;
}

function isWithinMaxAgeMonths(dateValue, maxAgeMonths) {
    const publishedDate = parsePublishedDate(dateValue);
    if (!publishedDate) return true; // Keep unknown dates; only filter when date is known.

    const threshold = new Date();
    threshold.setMonth(threshold.getMonth() - maxAgeMonths);
    return publishedDate >= threshold;
}

/**
 * Calculate editorial content score for a URL
 * Returns score 0-4 based on editorial signals
 */
function calculateEditorialScore(url, wordCount = null) {
    let score = 0;
    const urlLower = url.toLowerCase();
    const slug = url.split('/').filter(Boolean).pop() || '';
    
    // 1. Slug length > 30 chars (editorial slugs are descriptive)
    if (slug.length > 30) score++;
    
    // 2. Contains editorial keywords
    const editorialKeywords = ['how', 'why', 'what', 'guide', 'insights', 'explained', 'vs', 'versus', 'best', 'tips', 'ultimate', 'complete'];
    if (editorialKeywords.some(kw => slug.includes(kw))) score++;
    
    // 3. Word count > 500 (substantial content)
    if (wordCount && wordCount > 500) score++;
    
    // 4. No product/commercial patterns
    const commercialPatterns = ['/product', '/pricing', '/demo', '/buy', '/cart', '/checkout'];
    if (!commercialPatterns.some(pat => urlLower.includes(pat))) score++;
    
    return score;
}

/**
 * Check if URL passes minimum editorial quality threshold
 * Requires 3 of 4 signals to pass
 */
function isQualityEditorialContent(url, wordCount = null) {
    const score = calculateEditorialScore(url, wordCount);
    return score >= 3; // Need 3 of 4 signals
}

// ============================================
// SCRAPE FULL BLOG CONTENT
// ============================================
async function scrapeFullBlogContent(url) {
    try {
        console.log(`[Blog] Scraping full content: ${url}`);
        
        // Basic validation - exclude obvious non-content URLs
        const excludePatterns = [
            '/product', '/products', '/pricing', '/demo', '/features',
            '/landing', '/buy', '/cart', '/checkout', '/signup',
            '/login', '/api', '/docs', '/documentation'
        ];
        if (excludePatterns.some(pat => url.toLowerCase().includes(pat))) {
            console.log(`[Blog] URL looks like a product/service page: ${url}`);
            return null;
        }
        
        const { data } = await axios.get(url, {
            timeout: 8000,
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
            input: `Find ${limit} REAL editorial articles, blog posts, or guides published on ${domain}.

IMPORTANT SEARCH STRATEGY:
Use these Google search operators to find articles:
- site:${domain} "how to"
- site:${domain} "explained"  
- site:${domain} "guide"
- site:${domain} "why"
- site:${domain} "what is"
- site:${domain} "vs" OR "versus"
- site:${domain} "best"
- site:${domain} "tips"

WHAT TO LOOK FOR:
- Articles with LONG, DESCRIPTIVE SLUGS (e.g., "/how-to-automate-leasing-communications")
- Editorial content that teaches, explains, or compares
- Thought leadership pieces
- NOT product pages, pricing, demos, or landing pages
- URLs WITHOUT: /product, /pricing, /demo, /features, /landing, /buy

These might be "orphaned" articles not linked from main navigation - that's OK.

For each REAL article found:
- The exact full URL
- The article title
- A brief description of what it's about

Respond with JSON:
{
    "blogPosts": [
        {
            "url": "https://${domain}/example-article-slug",
            "title": "Article Title",
            "description": "Brief description"
        }
    ]
}

If no articles found, return: {"blogPosts": []}`
        });

        const content = response.output_text || "";
        console.log(`[Blog] OpenAI response received`);

        const parsed = extractJson(content);
        if (parsed?.blogPosts?.length > 0) {
            // RELAXED filtering: Accept URLs that look like editorial content
            // (long slugs with words, not product pages)
            const validPosts = parsed.blogPosts.filter(p => {
                const url = p.url.toLowerCase();
                // Exclude obvious non-blog patterns
                const excludePatterns = [
                    '/product', '/products', '/pricing', '/demo', '/features',
                    '/landing', '/buy', '/cart', '/checkout', '/signup',
                    '/login', '/contact', '/about', '/careers', '/jobs',
                    '/api', '/docs', '/documentation', '/help', '/support',
                    '/privacy', '/terms', '/legal', '/security', '/status',
                    '/integrations', '/partners', '/customers', '/company'
                ];
                if (excludePatterns.some(pat => url.includes(pat))) return false;
                
                // Must have a path (not just domain.com/)
                const path = new URL(p.url).pathname;
                if (path === '/' || path === '') return false;
                
                // Should look like an article slug (has words separated by dashes)
                const slug = path.split('/').filter(Boolean).pop() || '';
                return slug.includes('-') && slug.length > 10;
            });
            
            console.log(`[Blog] OpenAI found ${validPosts.length} valid EDITORIAL items (filtered from ${parsed.blogPosts.length})`);

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

        console.log("[Blog] OpenAI found no editorial content");
        return [];
    } catch (error) {
        console.log(`[Blog] OpenAI failed: ${error.message}`);
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

                    // Validate it's a real blog URL (strict mode)
                    const validation = isValidBlogUrl(href, true);
                    if (validation === true) {
                        urls.add(href);
                    }
                    // 'maybe' URLs will be validated later when scraping content
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
                    // For post-sitemap.xml, use RELAXED filtering (WordPress posts don't have /blog/ in URL)
                    const isPostSitemap = childUrl.toLowerCase().includes('post');
                    
                    try {
                        console.log(`[Blog] Fetching child sitemap: ${childUrl}`);
                        const childRes = await axios.get(childUrl, { timeout: 8000 });
                        const childMatches = childRes.data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
                        for (const m of childMatches) {
                            const url = m.replace(/<\/?loc>/gi, "");
                            // For post-sitemaps, use relaxed validation (WordPress structure)
                            if (isPostSitemap) {
                                if (isLikelyBlogPost(url)) {
                                    urls.add(url);
                                }
                            } else if (isValidBlogUrl(url, true) === true) {
                                urls.add(url);
                            }
                        }
                    } catch { }
                }

                // Also check direct URLs in this sitemap
                const matches = data.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
                for (const m of matches) {
                    const url = m.replace(/<\/?loc>/gi, "");
                    // Skip sitemap references themselves
                    if (url.endsWith('.xml')) continue;
                    // Use strict validation to check if it's a blog-like URL
                    if (isValidBlogUrl(url, true) === true) {
                        urls.add(url);
                    }
                }

                if (urls.size >= limit) {
                    console.log(`[Blog] Sitemap found ${urls.size} valid editorial URLs`);
                    break;
                }
            } catch (err) {
                // Silently continue to next sitemap
            }
        }

        if (urls.size > 0) {
            console.log(`[Blog] Sitemaps found total of ${urls.size} valid editorial URLs`);
        }
    }

    console.log(`[Blog] Total valid editorial URLs found: ${urls.size}`);

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
// STRATEGY 3: Puppeteer for JS-rendered pages (Next.js, React, etc.)
// ============================================
async function findBlogsWithPuppeteer(domain, limit = 10) {
    if (!puppeteer) {
        console.log("[Blog] Puppeteer not available, skipping");
        return [];
    }

    const urls = new Set();
    let browser = null;

    try {
        console.log(`[Blog] Starting Puppeteer for ${domain}...`);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        
        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Try /blog first
        const blogUrl = `https://${domain}/blog`;
        console.log(`[Blog] Puppeteer navigating to: ${blogUrl}`);
        
        try {
            await page.goto(blogUrl, { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });
            
            // Wait for content to load (common selectors for blog posts)
            await page.waitForFunction(() => {
                return document.querySelectorAll('article, [class*="post"], [class*="blog"], h2 a, h3 a').length > 0;
            }, { timeout: 10000 }).catch(() => {
                console.log("[Blog] No content selectors found, proceeding anyway...");
            });

            // Wait a bit more for any lazy-loaded content
            await new Promise(r => setTimeout(r, 2000));

        } catch (navError) {
            console.log(`[Blog] Puppeteer navigation error: ${navError.message}`);
            await browser.close();
            return [];
        }

        // Extract links using page.evaluate
        const links = await page.evaluate((domain) => {
            const results = [];
            
            // Try multiple selectors to find article links
            const selectors = [
                'article a[href]',
                '[class*="post"] a[href]',
                '[class*="blog"] a[href]',
                '[class*="article"] a[href]',
                'h2 a[href]',
                'h3 a[href]',
                '.card a[href]',
                'a[href*="/blog/"]',
                'a[href*="/post/"]',
                'a[href*="/article/"]',
                'main a[href]',
                '[role="main"] a[href]'
            ];
            
            for (const selector of selectors) {
                document.querySelectorAll(selector).forEach(el => {
                    const href = el.getAttribute('href');
                    if (href) {
                        // Make absolute URL
                        let absoluteUrl = href;
                        if (href.startsWith('/')) {
                            absoluteUrl = `https://${domain}${href}`;
                        } else if (!href.startsWith('http')) {
                            return;
                        }
                        
                        // Filter out common non-article paths
                        const skipPatterns = [
                            '/tag/', '/category/', '/author/', '/page/',
                            '/wp-content/', '/wp-admin/', '/cdn-cgi/',
                            '/assets/', '/static/', '/api/', '/_next/',
                            '#', '/search', '/login', '/signup', '/cart',
                            '/checkout', '/account', '/privacy', '/terms'
                        ];
                        
                        const isValid = !skipPatterns.some(p => absoluteUrl.includes(p));
                        const hasArticleSlug = absoluteUrl.split('/').pop()?.length > 10 ||
                                               absoluteUrl.split('/').pop()?.includes('-');
                        
                        if (isValid && hasArticleSlug) {
                            results.push(absoluteUrl);
                        }
                    }
                });
            }
            
            return [...new Set(results)];
        }, domain);

        console.log(`[Blog] Puppeteer found ${links.length} raw links`);
        
        // Filter and validate URLs (strict mode)
        for (const url of links) {
            if (isValidBlogUrl(url, true) === true) {
                urls.add(url);
            }
            if (urls.size >= limit) break;
        }

        console.log(`[Blog] Puppeteer found ${urls.size} valid editorial URLs`);

    } catch (error) {
        console.error(`[Blog] Puppeteer error: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
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
    const checks = await Promise.allSettled(
        posts.map((post) =>
            axios.head(post.url, {
                timeout: 5000,
                maxRedirects: 3,
                validateStatus: (s) => s >= 200 && s < 400
            })
        )
    );
    const verified = [];
    checks.forEach((check, idx) => {
        if (check.status === 'fulfilled') {
            verified.push(posts[idx]);
        } else {
            console.log(`[Blog] Skipped (not accessible): ${posts[idx].url}`);
        }
    });

    console.log(`[Blog] Verified ${verified.length}/${posts.length} editorial URLs`);
    return verified;
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let pointer = 0;

    const worker = async () => {
        while (pointer < items.length) {
            const idx = pointer++;
            results[idx] = await mapper(items[idx], idx);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
    );
    return results;
}

// ============================================
// MAIN: Find top 10 blogs and scrape full content
// ============================================
async function getBlogPosts(domain, limit = 10) {
    console.log(`[Blog] ═══ Finding TOP ${limit} EDITORIAL_CONTENT items for: ${domain} ═══`);

    let posts = [];

    // STRATEGY 1: OpenAI web search (MOST EFFECTIVE)
    // Uses semantic search to find editorial articles, even "orphaned" ones
    console.log("[Blog] Step 1: Using OpenAI web search to find articles...");
    posts = await findBlogsWithOpenAI(domain, limit);
    console.log(`[Blog] OpenAI found ${posts.length} blog posts`);

    // STRATEGY 2: Direct scraping + Sitemap (fallback)
    // Traditional crawling for sites with clear blog structure
    if (posts.length === 0) {
        console.log("[Blog] Step 2: Trying sitemap and page scraping...");
        const scrapedPosts = await findBlogsFromScraping(domain, limit);
        
        if (scrapedPosts.length > 0) {
            posts = scrapedPosts;
            console.log(`[Blog] Scraping found ${posts.length} posts`);
        }
    }

    // STRATEGY 3: Puppeteer for JS-rendered pages (Next.js, React apps)
    // Use when nothing else worked (likely a dynamic SPA)
    if (posts.length === 0 && puppeteer) {
        console.log("[Blog] Step 3: Trying Puppeteer for JS-rendered content...");
        const puppeteerPosts = await findBlogsWithPuppeteer(domain, limit);
        
        if (puppeteerPosts.length > 0) {
            posts = puppeteerPosts;
            console.log(`[Blog] Puppeteer found ${posts.length} editorial items from dynamic content`);
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
        const scrapeConcurrency = Math.max(1, Number(process.env.BLOG_SCRAPE_CONCURRENCY || 5));
        console.log(`[Blog] Scraping full content for ${posts.length} editorial items (concurrency: ${scrapeConcurrency})...`);

        const scrapedByIndex = await mapWithConcurrency(posts, scrapeConcurrency, async (post) => {
            return scrapeFullBlogContent(post.url);
        });

        const postsWithContent = [];
        for (let i = 0; i < posts.length; i++) {
            const scraped = scrapedByIndex[i];
            if (scraped && scraped.content) {
                // Filter out low-quality or unscrapeable content
                if (scraped.wordCount < 300) {
                    console.log(`[Blog] EDITORIAL_DETECTED_BUT_NOT_SCRAPABLE: ${posts[i].url} (${scraped.wordCount} words)`);
                    continue; // Skip this post - not enough content
                }
                
                // Calculate editorial quality score
                const score = calculateEditorialScore(posts[i].url, scraped.wordCount);
                console.log(`[Blog] Editorial score ${score}/4 for: ${posts[i].url}`);
                
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
                    scrapedAt: scraped.scrapedAt,
                    editorialScore: score,
                    contentType: 'EDITORIAL_CONTENT'
                });
            } else {
                console.log(`[Blog] EDITORIAL_DETECTED_BUT_NOT_SCRAPABLE: ${posts[i].url} (no content)`);
                // Don't include posts we can't scrape
            }
        }
        posts = postsWithContent;
    }

    if (posts.length === 0) {
        console.log(`[Blog] No editorial content found for ${domain}`);
        return [];
    }

    const maxAgeMonths = Math.max(1, Number(process.env.BLOG_MAX_AGE_MONTHS || 12));
    const beforeFreshness = posts.length;
    let droppedByAge = 0;
    let unknownDates = 0;

    posts = posts.filter((post) => {
        const parsedDate = parsePublishedDate(post.date);
        if (!parsedDate) {
            unknownDates += 1;
            return true;
        }
        const keep = isWithinMaxAgeMonths(parsedDate, maxAgeMonths);
        if (!keep) droppedByAge += 1;
        return keep;
    });

    if (beforeFreshness !== posts.length) {
        console.log(`[Blog] Freshness filter kept ${posts.length}/${beforeFreshness} (maxAgeMonths=${maxAgeMonths}, droppedByAge=${droppedByAge}, unknownDates=${unknownDates})`);
    } else {
        console.log(`[Blog] Freshness filter kept all ${posts.length} posts (maxAgeMonths=${maxAgeMonths}, unknownDates=${unknownDates})`);
    }

    // Sort by editorial score first, then by recency when date exists
    posts.sort((a, b) => {
        const scoreDiff = (b.editorialScore || 0) - (a.editorialScore || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const aTs = parsePublishedDate(a.date)?.getTime() || 0;
        const bTs = parsePublishedDate(b.date)?.getTime() || 0;
        return bTs - aTs;
    });

    console.log(`[Blog] ═══ Returning ${posts.length} EDITORIAL_CONTENT items with content ═══`);
    return posts;
}

module.exports = { getBlogPosts, scrapeFullBlogContent };
