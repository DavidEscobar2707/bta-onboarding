const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch llms.txt file if it exists
 * llms.txt is a standard for providing LLM-friendly site information
 * See: https://llmstxt.org/
 */
async function fetchLlmsTxt(domain) {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    
    // Try different possible locations for llms.txt
    const possiblePaths = [
        '/llms.txt',
        '/.well-known/llms.txt',
        '/llms-full.txt',
    ];

    for (const path of possiblePaths) {
        try {
            const url = `${baseUrl}${path}`;
            console.log(`[Sitemap] Trying llms.txt at: ${url}`);
            
            const response = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 10000,
                // Accept text responses
                responseType: 'text'
            });

            if (response.data && typeof response.data === 'string' && response.data.length > 10) {
                console.log(`[Sitemap] Found llms.txt at ${url} (${response.data.length} chars)`);
                return {
                    found: true,
                    url: url,
                    content: response.data.substring(0, 50000) // Limit size
                };
            }
        } catch (error) {
            // File not found at this path, try next
            console.log(`[Sitemap] llms.txt not found at: ${baseUrl}${path}`);
        }
    }

    return {
        found: false,
        url: null,
        content: null
    };
}

/**
 * Get all URLs from sitemap.xml
 */
async function getSitemapUrls(domain) {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    const sitemapUrls = [
        `${baseUrl}/sitemap.xml`,
        `${baseUrl}/sitemap_index.xml`,
    ];

    let allUrls = [];
    let sitemapFound = null;

    for (const sitemapUrl of sitemapUrls) {
        try {
            console.log(`[Sitemap] Trying: ${sitemapUrl}`);
            const response = await axios.get(sitemapUrl, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 10000
            });

            const $ = cheerio.load(response.data, { xmlMode: true });
            sitemapFound = sitemapUrl;

            // Check if it's a sitemap index
            const sitemapLocs = $('sitemap loc').map((_, el) => $(el).text()).get();

            if (sitemapLocs.length > 0) {
                // It's a sitemap index
                console.log(`[Sitemap] Found sitemap index with ${sitemapLocs.length} child sitemaps`);
                
                // Fetch each child sitemap
                for (const childSitemap of sitemapLocs) {
                    try {
                        const childResponse = await axios.get(childSitemap, {
                            headers: { 'User-Agent': USER_AGENT },
                            timeout: 10000
                        });
                        const child$ = cheerio.load(childResponse.data, { xmlMode: true });
                        
                        child$('url').each((_, urlEl) => {
                            const loc = child$(urlEl).find('loc').text();
                            const lastmod = child$(urlEl).find('lastmod').text();
                            const priority = child$(urlEl).find('priority').text();
                            
                            if (loc) {
                                allUrls.push({
                                    url: loc,
                                    lastmod: lastmod || null,
                                    priority: priority || null,
                                    sitemap: childSitemap
                                });
                            }
                        });
                    } catch (e) {
                        console.log(`[Sitemap] Failed to fetch child sitemap: ${childSitemap}`);
                    }
                }
            } else {
                // Regular sitemap
                $('url').each((_, urlEl) => {
                    const loc = $(urlEl).find('loc').text();
                    const lastmod = $(urlEl).find('lastmod').text();
                    const priority = $(urlEl).find('priority').text();
                    
                    if (loc) {
                        allUrls.push({
                            url: loc,
                            lastmod: lastmod || null,
                            priority: priority || null,
                            sitemap: sitemapUrl
                        });
                    }
                });
            }

            if (allUrls.length > 0) {
                console.log(`[Sitemap] Found ${allUrls.length} URLs total`);
                break;
            }
        } catch (error) {
            console.log(`[Sitemap] Sitemap not found at: ${sitemapUrl}`);
        }
    }

    // Categorize URLs
    const categorized = categorizeUrls(allUrls);

    return {
        sitemapUrl: sitemapFound,
        totalUrls: allUrls.length,
        urls: allUrls.slice(0, 500), // Limit to 500 URLs
        categories: categorized
    };
}

/**
 * Categorize URLs by type
 */
function categorizeUrls(urls) {
    const categories = {
        blog: [],
        products: [],
        pages: [],
        other: []
    };

    const patterns = {
        blog: [/\/blog\//i, /\/posts?\//i, /\/articles?\//i, /\/news\//i],
        products: [/\/products?\//i, /\/services?\//i, /\/solutions?\//i, /\/features?\//i],
        pages: [/\/about/i, /\/contact/i, /\/pricing/i, /\/team/i, /\/careers/i]
    };

    for (const item of urls) {
        let categorized = false;
        
        for (const [category, patternList] of Object.entries(patterns)) {
            if (patternList.some(p => p.test(item.url))) {
                categories[category].push(item.url);
                categorized = true;
                break;
            }
        }
        
        if (!categorized) {
            categories.other.push(item.url);
        }
    }

    return {
        blog: categories.blog.length,
        products: categories.products.length,
        pages: categories.pages.length,
        other: categories.other.length
    };
}

/**
 * Fetch robots.txt for additional context
 */
async function fetchRobotsTxt(domain) {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    
    try {
        const url = `${baseUrl}/robots.txt`;
        console.log(`[Sitemap] Fetching robots.txt: ${url}`);
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000,
            responseType: 'text'
        });

        return {
            found: true,
            url: url,
            content: response.data.substring(0, 10000)
        };
    } catch (error) {
        console.log(`[Sitemap] robots.txt not found`);
        return {
            found: false,
            url: null,
            content: null
        };
    }
}

/**
 * Main function: Get all sitemap data for a domain
 */
async function getSitemapData(domain) {
    console.log(`[Sitemap] Starting sitemap analysis for: ${domain}`);

    const [llmsTxt, sitemapUrls, robotsTxt] = await Promise.all([
        fetchLlmsTxt(domain),
        getSitemapUrls(domain),
        fetchRobotsTxt(domain)
    ]);

    return {
        domain,
        llmsTxt,
        sitemap: sitemapUrls,
        robotsTxt
    };
}

module.exports = { 
    getSitemapData, 
    fetchLlmsTxt, 
    getSitemapUrls, 
    fetchRobotsTxt 
};
