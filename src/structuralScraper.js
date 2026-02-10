const axios = require("axios");
const cheerio = require("cheerio");

/**
 * FASE 1: Scraping estructural SIN LLM
 * Extrae hechos de páginas clave (home, pricing, features, about)
 * Output: JSON estructurado, no texto crudo
 */

const KEY_PAGES = [
    "/",
    "/pricing",
    "/features",
    "/product",
    "/about",
    "/customers",
    "/case-studies",
    "/integrations",
    "/security",
    "/compliance"
];

async function scrapePage(domain, path) {
    try {
        const url = `https://${domain}${path}`;
        const { data } = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        return cheerio.load(data);
    } catch {
        return null;
    }
}

function extractText($, selectors) {
    for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text && text.length > 10) return text;
    }
    return null;
}

function extractList($, selector) {
    return $(selector)
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text.length > 5 && text.length < 200);
}

function extractKeywords(text, minLength = 4) {
    if (!text) return [];
    // Extrae palabras clave frecuentes (nombres de features, industrias, etc.)
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= minLength && !isStopWord(w));
    
    const counts = {};
    words.forEach(w => counts[w] = (counts[w] || 0) + 1);
    
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word, count]) => word);
}

function isStopWord(word) {
    const stopWords = new Set([
        'with', 'from', 'they', 'have', 'this', 'will', 'your', 'that', 'their',
        'more', 'about', 'what', 'when', 'where', 'which', 'while', 'than',
        'them', 'these', 'those', 'then', 'here', 'there', 'every', 'some',
        'very', 'after', 'before', 'being', 'having', 'doing', 'make', 'made',
        'take', 'come', 'know', 'just', 'like', 'over', 'also', 'back', 'only',
        'think', 'look', 'time', 'year', 'work', 'way', 'even', 'new', 'want',
        'because', 'good', 'could', 'would', 'should', 'said', 'each', 'many',
        'well', 'much', 'how', 'its', 'and', 'the', 'for', 'are', 'but', 'not',
        'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day',
        'get', 'has', 'him', 'his', 'how', 'man', 'men', 'now', 'old', 'see',
        'two', 'who', 'boy', 'did', 'she', 'use', 'her', 'way', 'many', 'oil',
        'sit', 'set', 'run', 'eat', 'far', 'sea', 'eye', 'ask', 'own', 'say',
        'too', 'any', 'try', 'let', 'put', 'say', 'she', 'try', 'way', 'own',
        'say', 'too', 'old', 'tell', 'very', 'when', 'much', 'would', 'there',
        'their', 'what', 'said', 'each', 'which', 'she', 'how', 'will', 'about',
        'could', 'other', 'after', 'first', 'never', 'these', 'think', 'where',
        'being', 'every', 'great', 'might', 'shall', 'still', 'those', 'while',
        'this', 'have', 'from', 'they', 'know', 'want', 'been', 'were', 'said',
        'time', 'than', 'them', 'into', 'just', 'like', 'over', 'also', 'back',
        'only', 'come', 'made', 'most', 'well', 'even', 'year', 'work', 'such',
        'what', 'your', 'said', 'each', 'which', 'make', 'like', 'into', 'him'
    ]);
    return stopWords.has(word);
}

function detectPricingModel(text) {
    if (!text) return 'unknown';
    const t = text.toLowerCase();
    if (t.includes('per user') || t.includes('/user') || t.includes('per seat')) return 'per-seat';
    if (t.includes('usage') || t.includes('pay as you go') || t.includes('consumption')) return 'usage-based';
    if (t.includes('flat') || t.includes('fixed')) return 'flat-rate';
    if (t.includes('tier') || t.includes('plan') || t.includes('starter') || t.includes('pro') || t.includes('enterprise')) return 'tiered';
    if (t.includes('custom') || t.includes('contact sales')) return 'custom';
    if (t.includes('free')) return 'freemium';
    return 'unknown';
}

async function scrapeStructuralData(domain) {
    console.log(`[Structural] Scraping key pages for ${domain}...`);
    
    const result = {
        value_props: [],
        features: [],
        industries: [],
        compliance_mentions: [],
        pricing_model: 'unknown',
        keywords: [],
        headline: null,
        subheadline: null,
        target_audience: [],
        integrations_mentioned: [],
        page_results: {}
    };

    const pageFetches = await Promise.allSettled([
        scrapePage(domain, '/'),
        scrapePage(domain, '/pricing'),
        scrapePage(domain, '/features'),
        scrapePage(domain, '/product'),
        scrapePage(domain, '/about'),
        scrapePage(domain, '/security'),
        scrapePage(domain, '/compliance'),
        scrapePage(domain, '/integrations')
    ]);

    const $home = pageFetches[0].status === 'fulfilled' ? pageFetches[0].value : null;
    const $pricing = pageFetches[1].status === 'fulfilled' ? pageFetches[1].value : null;
    const $features = (pageFetches[2].status === 'fulfilled' ? pageFetches[2].value : null)
        || (pageFetches[3].status === 'fulfilled' ? pageFetches[3].value : null);
    const $about = pageFetches[4].status === 'fulfilled' ? pageFetches[4].value : null;
    const $security = (pageFetches[5].status === 'fulfilled' ? pageFetches[5].value : null)
        || (pageFetches[6].status === 'fulfilled' ? pageFetches[6].value : null);
    const $integrations = pageFetches[7].status === 'fulfilled' ? pageFetches[7].value : null;

    // Scrape homepage
    if ($home) {
        result.headline = extractText($home, ['h1', '.hero h1', 'header h1', '[class*="hero"] h1']);
        result.subheadline = extractText($home, ['h2', '.hero h2', '.subtitle', '[class*="subhead"]']);
        result.value_props = extractList($home, 'h2, h3, .feature h3, [class*="value"] h3, [class*="benefit"] h3');
        
        // Extract all text for keyword analysis
        const allText = $home('body').text();
        result.keywords = extractKeywords(allText);
        
        result.page_results.home = 'success';
    }

    // Scrape pricing
    if ($pricing) {
        const pricingText = $pricing('body').text();
        result.pricing_model = detectPricingModel(pricingText);
        result.page_results.pricing = 'success';
    }

    // Scrape features/product
    if ($features) {
        result.features = extractList($features, 
            'h3, .feature h3, [class*="feature"] h3, [class*="capability"] h3, li strong'
        );
        result.page_results.features = 'success';
    }

    // Scrape about
    if ($about) {
        const aboutText = $about('body').text().toLowerCase();
        // Detect industries mentioned
        const industryKeywords = ['real estate', 'healthcare', 'fintech', 'saas', 'ecommerce', 'retail', 
            'manufacturing', 'logistics', 'education', 'government', 'nonprofit', 'startup', 'enterprise'];
        result.industries = industryKeywords.filter(ind => aboutText.includes(ind));
        result.page_results.about = 'success';
    }

    // Scrape security/compliance
    if ($security) {
        const secText = $security('body').text().toLowerCase();
        const complianceKeywords = ['soc 2', 'gdpr', 'hipaa', 'iso 27001', 'ccpa', 'pci', 'gdpr', 'gdpr'];
        result.compliance_mentions = complianceKeywords.filter(comp => secText.includes(comp));
        result.page_results.security = 'success';
    }

    // Scrape integrations
    if ($integrations) {
        result.integrations_mentioned = extractList($integrations, 
            'h3, .integration h3, [class*="integration"] h3, img[alt]'
        ).map(i => i.replace(/integration|connector/gi, '').trim());
        result.page_results.integrations = 'success';
    }

    console.log(`[Structural] Results: ${Object.keys(result.page_results).length} pages scraped`);
    console.log(`[Structural] Value props: ${result.value_props.length}, Features: ${result.features.length}`);
    
    return result;
}

module.exports = { scrapeStructuralData, KEY_PAGES };
