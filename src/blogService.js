const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch and parse sitemap.xml to find blog-related URLs
 */
async function fetchSitemap(domain) {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    const sitemapUrls = [
        `${baseUrl}/sitemap.xml`,
        `${baseUrl}/sitemap_index.xml`,
        `${baseUrl}/post-sitemap.xml`,
        `${baseUrl}/blog-sitemap.xml`,
    ];

    let allUrls = [];

    for (const sitemapUrl of sitemapUrls) {
        try {
            console.log(`[Blog] Trying sitemap: ${sitemapUrl}`);
            const response = await axios.get(sitemapUrl, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 10000
            });

            const $ = cheerio.load(response.data, { xmlMode: true });

            // Check if it's a sitemap index (contains other sitemaps)
            const sitemapLocs = $('sitemap loc').map((_, el) => $(el).text()).get();
            
            if (sitemapLocs.length > 0) {
                // It's a sitemap index, fetch child sitemaps
                console.log(`[Blog] Found sitemap index with ${sitemapLocs.length} child sitemaps`);
                for (const childSitemap of sitemapLocs.slice(0, 5)) { // Limit to 5 child sitemaps
                    try {
                        const childResponse = await axios.get(childSitemap, {
                            headers: { 'User-Agent': USER_AGENT },
                            timeout: 10000
                        });
                        const child$ = cheerio.load(childResponse.data, { xmlMode: true });
                        const childUrls = child$('url loc').map((_, el) => child$(el).text()).get();
                        allUrls = allUrls.concat(childUrls);
                    } catch (e) {
                        console.log(`[Blog] Failed to fetch child sitemap: ${childSitemap}`);
                    }
                }
            } else {
                // Regular sitemap with URLs
                const urls = $('url loc').map((_, el) => $(el).text()).get();
                allUrls = allUrls.concat(urls);
            }

            if (allUrls.length > 0) {
                console.log(`[Blog] Found ${allUrls.length} URLs in sitemap`);
                break;
            }
        } catch (error) {
            console.log(`[Blog] Sitemap not found at: ${sitemapUrl}`);
        }
    }

    return allUrls;
}

/**
 * Filter URLs to find likely blog posts
 */
function filterBlogUrls(urls) {
    const blogPatterns = [
        /\/blog\//i,
        /\/posts?\//i,
        /\/articles?\//i,
        /\/news\//i,
        /\/insights?\//i,
        /\/resources?\//i,
        /\/learn\//i,
        /\/guides?\//i,
        /\/stories?\//i,
        /\/updates?\//i,
    ];

    // Filter URLs that match blog patterns
    let blogUrls = urls.filter(url => {
        return blogPatterns.some(pattern => pattern.test(url));
    });

    // Exclude common non-blog pages
    const excludePatterns = [
        /\/tag\//i,
        /\/category\//i,
        /\/author\//i,
        /\/page\/\d+/i,
        /\/wp-content\//i,
        /\/wp-admin\//i,
        /\.(jpg|jpeg|png|gif|pdf|xml|json)$/i,
    ];

    blogUrls = blogUrls.filter(url => {
        return !excludePatterns.some(pattern => pattern.test(url));
    });

    // Sort by URL length (shorter URLs are usually more recent/important)
    // and take unique URLs
    const uniqueUrls = [...new Set(blogUrls)];
    
    return uniqueUrls;
}

/**
 * Scrape a single blog post for metadata
 */
async function scrapeBlogPost(url, id) {
    try {
        console.log(`[Blog] Scraping: ${url}`);
        const response = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);

        // Remove unwanted elements
        $('script, style, noscript, iframe, nav, header, footer, aside').remove();

        // Extract title
        const title = 
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('h1').first().text().trim() ||
            $('title').text().trim() ||
            'Untitled';

        // Extract date
        let date = 
            $('meta[property="article:published_time"]').attr('content') ||
            $('meta[name="date"]').attr('content') ||
            $('time[datetime]').attr('datetime') ||
            $('time').first().text().trim() ||
            '';
        
        // Format date if found
        if (date) {
            try {
                const parsedDate = new Date(date);
                if (!isNaN(parsedDate.getTime())) {
                    date = parsedDate.toISOString().split('T')[0];
                }
            } catch (e) {
                // Keep original date string
            }
        }

        // Extract image
        const image = 
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            $('article img').first().attr('src') ||
            $('.post-content img, .entry-content img, .blog-content img').first().attr('src') ||
            `https://picsum.photos/seed/${id}/800/400`; // Fallback placeholder

        // Extract description
        const description = 
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            $('meta[name="twitter:description"]').attr('content') ||
            '';

        // Extract body text preview
        const bodySelectors = [
            'article',
            '.post-content',
            '.entry-content',
            '.blog-content',
            '.content',
            'main',
            '.prose'
        ];

        let bodyText = '';
        for (const selector of bodySelectors) {
            const content = $(selector).text().trim();
            if (content && content.length > 100) {
                bodyText = content;
                break;
            }
        }

        // Clean and truncate body
        bodyText = bodyText
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 500);

        // Use description as body fallback
        if (!bodyText || bodyText.length < 50) {
            bodyText = description || 'Content preview not available.';
        }

        return {
            id,
            title: title.substring(0, 150),
            date: date || new Date().toISOString().split('T')[0],
            image: image,
            description: description.substring(0, 200) || bodyText.substring(0, 200),
            body: bodyText,
            url: url
        };
    } catch (error) {
        console.error(`[Blog] Failed to scrape ${url}:`, error.message);
        return null;
    }
}

/**
 * Main function: Get blog posts from a domain
 */
async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] Starting blog scraping for: ${domain}`);

    // Step 1: Fetch sitemap
    const allUrls = await fetchSitemap(domain);
    
    if (allUrls.length === 0) {
        console.log(`[Blog] No sitemap found, trying to discover blog page...`);
        // Fallback: try to find blog listing page
        return await discoverBlogFromPage(domain, limit);
    }

    // Step 2: Filter for blog URLs
    const blogUrls = filterBlogUrls(allUrls);
    console.log(`[Blog] Found ${blogUrls.length} potential blog URLs`);

    if (blogUrls.length === 0) {
        console.log(`[Blog] No blog URLs found in sitemap`);
        return [];
    }

    // Step 3: Scrape each blog post (limit to requested amount)
    const urlsToScrape = blogUrls.slice(0, limit);
    const blogPosts = [];

    for (let i = 0; i < urlsToScrape.length; i++) {
        const post = await scrapeBlogPost(urlsToScrape[i], i + 1);
        if (post) {
            blogPosts.push(post);
        }
        // Small delay to be respectful
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[Blog] Successfully scraped ${blogPosts.length} blog posts`);
    return blogPosts;
}

/**
 * Fallback: Try to discover blog posts from common blog pages
 */
async function discoverBlogFromPage(domain, limit) {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    const blogPaths = ['/blog', '/posts', '/articles', '/news', '/insights', '/resources'];

    for (const path of blogPaths) {
        try {
            const blogUrl = `${baseUrl}${path}`;
            console.log(`[Blog] Trying blog page: ${blogUrl}`);
            
            const response = await axios.get(blogUrl, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 10000
            });

            const $ = cheerio.load(response.data);

            // Find links that look like blog posts
            const links = $('a[href*="/blog/"], a[href*="/post"], a[href*="/article"]')
                .map((_, el) => {
                    let href = $(el).attr('href');
                    if (href && !href.startsWith('http')) {
                        href = new URL(href, baseUrl).toString();
                    }
                    return href;
                })
                .get()
                .filter(Boolean);

            const uniqueLinks = [...new Set(links)].slice(0, limit);

            if (uniqueLinks.length > 0) {
                console.log(`[Blog] Found ${uniqueLinks.length} blog links on ${blogUrl}`);
                
                const blogPosts = [];
                for (let i = 0; i < uniqueLinks.length; i++) {
                    const post = await scrapeBlogPost(uniqueLinks[i], i + 1);
                    if (post) {
                        blogPosts.push(post);
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                
                return blogPosts;
            }
        } catch (error) {
            console.log(`[Blog] Blog page not found at: ${baseUrl}${path}`);
        }
    }

    console.log(`[Blog] Could not discover any blog posts`);
    return [];
}

module.exports = { getBlogPosts, fetchSitemap, filterBlogUrls };
