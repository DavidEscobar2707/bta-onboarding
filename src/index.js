const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { generateClientData } = require('./aiService');
const { getBlogPosts } = require('./blogService');
const { getSitemapData } = require('./sitemapService');
const { submitToAirtable, getClientsFromAirtable } = require('./airtableService');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

// Helper function to search Brave if scraping fails
async function searchBrave(query) {
    if (!BRAVE_API_KEY) {
        console.warn("[BTA] No BRAVE_API_KEY found. Skipping fallback search.");
        return null;
    }
    try {
        console.log(`[BTA] Fallback: Searching Brave for '${query}'...`);
        const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': BRAVE_API_KEY
            },
            params: { q: query, count: 5 }
        });
        
        // Concatenate titles and descriptions from results
        const results = response.data.web?.results || [];
        return results.map(r => `Title: ${r.title}\nDescription: ${r.description}`).join('\n\n');
    } catch (error) {
        console.error("[BTA] Brave Search failed:", error.message);
        return null;
    }
}

app.post('/api/onboard', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    try {
        console.log(`[BTA] Starting onboarding for: ${domain}`);
        
        const url = domain.startsWith('http') ? domain : `https://${domain}`;
        let contextText = '';
        
        // 1. Direct Scraping Attempt
        try {
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 5000
            });
            const $ = cheerio.load(response.data);
            $('script, style, noscript, iframe, svg').remove();
            contextText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 15000);
            console.log(`[BTA] Scraped successfully (${contextText.length} chars).`);
        } catch (scrapeError) {
            console.warn(`[BTA] Scraping failed: ${scrapeError.message}. Initiating Brave Fallback.`);
            
            // 2. Fallback: Brave Search
            const searchData = await searchBrave(`site:${domain} OR "${domain}" about features pricing`);
            if (searchData) {
                contextText = `Could not access main site directly. Here is a summary from search results:\n${searchData}`;
            } else {
                contextText = `Domain: ${domain}. (Site inaccessible and no search fallback available). Generate hypothetical data based on domain name.`;
            }
        }

        // 3. AI Analysis with Gemini/OpenAI
        const aiData = await generateClientData(domain, contextText);
        
        if (!aiData) {
            throw new Error("AI Analysis failed completely.");
        }

        const name = domain.replace(/\.(com|io|net|org).*/, '');
        
        res.json({
            domain,
            name: aiData.name || name.charAt(0).toUpperCase() + name.slice(1),
            status: 'success',
            data: aiData
        });

    } catch (error) {
        console.error('CRITICAL ERROR:', error);
        res.status(500).json({ error: 'Failed to process domain', details: error.message });
    }
});

// ============================================
// NEW ENDPOINT: Scrape Blog Posts
// ============================================
app.post('/api/blogs', async (req, res) => {
    const { domain, limit = 20 } = req.body;
    
    if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
    }

    try {
        console.log(`[BTA] Starting blog scraping for: ${domain}`);
        
        const blogPosts = await getBlogPosts(domain, limit);
        
        res.json({
            domain,
            status: 'success',
            count: blogPosts.length,
            blogPosts
        });
    } catch (error) {
        console.error('[BTA] Blog scraping error:', error);
        res.status(500).json({ 
            error: 'Failed to scrape blog posts', 
            details: error.message,
            blogPosts: [] // Return empty array on error
        });
    }
});

// ============================================
// NEW ENDPOINT: Get Sitemap & llms.txt
// ============================================
app.post('/api/sitemap', async (req, res) => {
    const { domain } = req.body;
    
    if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
    }

    try {
        console.log(`[BTA] Starting sitemap analysis for: ${domain}`);
        
        const sitemapData = await getSitemapData(domain);
        
        res.json({
            domain,
            status: 'success',
            ...sitemapData
        });
    } catch (error) {
        console.error('[BTA] Sitemap analysis error:', error);
        res.status(500).json({ 
            error: 'Failed to analyze sitemap', 
            details: error.message 
        });
    }
});

// ============================================
// SUBMIT TO AIRTABLE
// ============================================
app.post('/api/submit', async (req, res) => {
    const { clientData, competitors, likedPosts, customUrls, compData } = req.body;
    
    if (!clientData) {
        return res.status(400).json({ error: 'Client data is required' });
    }

    try {
        console.log(`[BTA] Submitting to Airtable: ${clientData.domain}`);
        
        const result = await submitToAirtable({
            clientData,
            competitors,
            likedPosts,
            customUrls,
            compData
        });
        
        res.json({
            status: 'success',
            message: 'Onboarding data submitted to Airtable',
            ...result
        });
    } catch (error) {
        console.error('[BTA] Airtable submission error:', error);
        res.status(500).json({ 
            error: 'Failed to submit to Airtable', 
            details: error.message 
        });
    }
});

// ============================================
// GET ALL CLIENTS (Optional utility)
// ============================================
app.get('/api/clients', async (req, res) => {
    try {
        const clients = await getClientsFromAirtable();
        res.json({
            status: 'success',
            count: clients.length,
            clients
        });
    } catch (error) {
        console.error('[BTA] Error fetching clients:', error);
        res.status(500).json({ 
            error: 'Failed to fetch clients', 
            details: error.message 
        });
    }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`[BTA Backend] Running on port ${PORT}`);
    console.log(`[BTA Backend] Endpoints available:`);
    console.log(`  POST /api/onboard  - Analyze company data`);
    console.log(`  POST /api/blogs    - Scrape blog posts`);
    console.log(`  POST /api/sitemap  - Get sitemap & llms.txt`);
    console.log(`  POST /api/submit   - Submit to Airtable`);
    console.log(`  GET  /api/clients  - Get all clients from Airtable`);
    console.log(`  GET  /api/health   - Health check`);
});
