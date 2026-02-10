const axios = require("axios");
const cheerio = require("cheerio");
const { scrapeStructuralData } = require("./structuralScraper");

/**
 * FASE 3: Competitor Lookup (ligero, no crawl profundo)
 * Solo homepage, pricing, y búsqueda G2/Capterra
 * Output: Metadata comparativa, no contenido completo
 */

async function quickScrape(domain) {
    try {
        const { data } = await axios.get(`https://${domain}`, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        return cheerio.load(data);
    } catch {
        return null;
    }
}

function extractMetaDescription($) {
    return $('meta[name="description"]').attr('content') ||
           $('meta[property="og:description"]').attr('content') ||
           null;
}

function extractTitle($) {
    const title = $('title').text() || 
                  $('h1').first().text() ||
                  $('meta[property="og:title"]').attr('content');
    return title ? title.split(/[\|\-–]/)[0].trim() : null;
}

function detectCategory(description) {
    if (!description) return 'unknown';
    const d = description.toLowerCase();
    
    const categories = [
        { name: 'CRM', keywords: ['crm', 'customer relationship', 'sales pipeline'] },
        { name: 'Lead Generation', keywords: ['lead', 'prospect', 'outbound', 'inbound'] },
        { name: 'Marketing Automation', keywords: ['marketing', 'automation', 'email', 'campaign'] },
        { name: 'Real Estate Tech', keywords: ['real estate', 'property', 'wholesaling', 'investment'] },
        { name: 'Data/Analytics', keywords: ['data', 'analytics', 'insights', 'intelligence'] },
        { name: 'Communication', keywords: ['communication', 'messaging', 'chat', 'call'] },
        { name: 'Project Management', keywords: ['project', 'task', 'workflow', 'collaboration'] },
        { name: 'Finance/Billing', keywords: ['billing', 'invoice', 'payment', 'finance'] },
        { name: 'AI/Automation', keywords: ['ai', 'artificial intelligence', 'automation', 'ml'] }
    ];
    
    for (const cat of categories) {
        if (cat.keywords.some(kw => d.includes(kw))) return cat.name;
    }
    return 'unknown';
}

function detectPositioning(description, title) {
    if (!description) return 'unknown';
    const text = (description + ' ' + title).toLowerCase();
    
    if (text.includes('enterprise') || text.includes('fortune')) return 'enterprise';
    if (text.includes('startup') || text.includes('founder')) return 'startup';
    if (text.includes('small business') || text.includes('smb')) return 'smb';
    if (text.includes('mid-market') || text.includes('growth')) return 'mid-market';
    if (text.includes('developer') || text.includes('api')) return 'developer-first';
    return 'general';
}

async function lookupCompetitor(domain, clientDomain) {
    console.log(`[Competitor] Quick lookup: ${domain}`);
    
    const result = {
        domain,
        name: null,
        tagline: null,
        category: 'unknown',
        positioning: 'unknown',
        key_features: [],
        pricing_hint: null,
        target_audience: [],
        differentiators: [],
        overlap_score: 0, // 0-1 similarity with client
        data_quality: 'low'
    };

    // 1. Homepage scrape (rápido)
    const $ = await quickScrape(domain);
    if ($) {
        result.name = extractTitle($);
        result.tagline = extractMetaDescription($);
        result.category = detectCategory(result.tagline);
        result.positioning = detectPositioning(result.tagline, result.name);
        
        // Extraer features mencionadas en homepage
        const featureWords = $('h2, h3').slice(0, 8).map((i, el) => $(el).text().trim()).get();
        result.key_features = featureWords
            .filter(f => f.length > 10 && f.length < 80)
            .slice(0, 5);
        
        result.data_quality = 'medium';
    }

    // 2. Intentar estructural scraper ligero
    try {
        const structural = await scrapeStructuralData(domain);
        if (structural.value_props.length > 0) {
            result.differentiators = structural.value_props.slice(0, 3);
        }
        if (structural.pricing_model !== 'unknown') {
            result.pricing_hint = structural.pricing_model;
        }
        if (structural.industries.length > 0) {
            result.target_audience = structural.industries;
        }
        result.data_quality = 'high';
    } catch {
        // Continue con lo que tenemos
    }

    // 3. Calcular overlap score con cliente
    // (placeholder - se calcula después comparando con cliente)
    result.overlap_score = null;

    console.log(`[Competitor] ${domain}: ${result.name} | ${result.category} | ${result.data_quality}`);
    return result;
}

async function lookupCompetitors(competitorDomains, clientDomain) {
    console.log(`[Competitor] Looking up ${competitorDomains.length} competitors...`);
    
    const results = [];
    
    // Procesar secuencialmente para no ser agresivo
    for (const domain of competitorDomains) {
        const data = await lookupCompetitor(domain, clientDomain);
        results.push(data);
        // Pausa entre requests
        await new Promise(r => setTimeout(r, 1000));
    }
    
    return results;
}

/**
 * Genera matriz comparativa simple
 */
function generateComparisonMatrix(clientData, competitors) {
    return {
        client: {
            name: clientData.name,
            category: clientData.category || 'unknown',
            positioning: clientData.positioning || 'unknown'
        },
        competitors: competitors.map(comp => ({
            domain: comp.domain,
            name: comp.name,
            category: comp.category,
            positioning: comp.positioning,
            overlap_score: comp.overlap_score,
            key_difference: comp.differentiators[0] || 'unknown'
        })),
        market_landscape: {
            total_competitors: competitors.length,
            categories_present: [...new Set(competitors.map(c => c.category).filter(Boolean))],
            positioning_distribution: competitors.reduce((acc, c) => {
                acc[c.positioning] = (acc[c.positioning] || 0) + 1;
                return acc;
            }, {})
        }
    };
}

module.exports = {
    lookupCompetitor,
    lookupCompetitors,
    generateComparisonMatrix
};
