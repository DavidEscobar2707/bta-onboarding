const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { generateClientData } = require('./aiService');
const { getBlogPosts } = require('./blogService');
const { submitToAirtable, getClientsFromAirtable } = require('./airtableService');
const { submitToNotion } = require('./notionService');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// In-memory store for form tokens (maps token -> domain)
const formTokens = new Map();

// ============================================
// 1. ONBOARD: Research a domain via LLM
// ============================================
app.post('/api/onboard', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    try {
        console.log(`[BTA] Researching: ${domain}`);
        const aiData = await generateClientData(domain);

        if (!aiData) {
            throw new Error("AI research failed.");
        }

        const name = aiData.name || domain.replace(/\.(com|io|net|org).*/, '');

        res.json({
            domain,
            name: name.charAt(0).toUpperCase() + name.slice(1),
            status: 'success',
            data: aiData,
        });
    } catch (error) {
        console.error('[BTA] Error:', error.message);
        res.status(500).json({ error: 'Failed to research domain', details: error.message });
    }
});

// ============================================
// 2. BLOGS: Find blog posts via AI (replaces scraper)
// ============================================
app.post('/api/blogs', async (req, res) => {
    const { domain, limit = 20 } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    try {
        console.log(`[BTA] Finding blog posts for: ${domain}`);
        const blogPosts = await getBlogPosts(domain, limit);
        res.json({ domain, status: 'success', count: blogPosts.length, blogPosts });
    } catch (error) {
        console.error('[BTA] Blog error:', error.message);
        res.status(500).json({ error: 'Failed to find blog posts', details: error.message, blogPosts: [] });
    }
});

// ============================================
// 3. SITEMAP: Minimal response (no longer scraped)
// ============================================
app.post('/api/sitemap', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    res.json({
        domain,
        status: 'success',
        llmsTxt: null,
        sitemap: { sitemapUrl: null, totalUrls: 0, urls: [], categories: {} },
        robotsTxt: { found: false, url: null, content: null },
    });
});

// ============================================
// 4. FORM LINK: Generate a shareable link for the client
// ============================================
app.post('/api/form/create', (req, res) => {
    const { domain, clientName, clientData, competitors } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    const token = uuidv4();
    const tokenData = {
        domain,
        clientName: clientName || domain,
        clientData: clientData || null,
        competitors: competitors || [],
        createdAt: new Date(),
    };
    formTokens.set(token, tokenData);

    console.log(`[BTA] Form link created for ${domain} | token: ${token} | clientData: ${clientData ? 'YES (' + Object.keys(clientData).join(',') + ')' : 'NO'} | competitors: ${(competitors || []).length}`);

    res.json({ status: 'success', token });
});

// Get form info by token (frontend calls this to show the form)
app.get('/api/form/:token', (req, res) => {
    const data = formTokens.get(req.params.token);
    if (!data) return res.status(404).json({ error: 'Form not found or expired' });

    res.json({ status: 'success', ...data });
});

// Client submits the form
app.post('/api/form/:token/submit', async (req, res) => {
    const tokenData = formTokens.get(req.params.token);
    if (!tokenData) return res.status(404).json({ error: 'Form not found or expired' });

    try {
        const result = await submitToAirtable({
            clientData: {
                domain: tokenData.domain,
                name: tokenData.clientName,
                data: req.body,
            },
            competitors: req.body.competitors || [],
            likedPosts: req.body.likedPosts || [],
            customUrls: req.body.customUrls || [],
        });

        formTokens.delete(req.params.token);

        res.json({ status: 'success', message: 'Data submitted to Airtable', ...result });
    } catch (error) {
        console.error('[BTA] Form submit error:', error.message);
        res.status(500).json({ error: 'Failed to submit', details: error.message });
    }
});

// ============================================
// 5. SUBMIT: Direct submit to Airtable (from dashboard)
// ============================================
app.post('/api/submit', async (req, res) => {
    const { clientData, competitors, likedPosts, customUrls, compData } = req.body;
    if (!clientData) return res.status(400).json({ error: 'Client data is required' });

    console.log(`[BTA] Submitting to Airtable + Notion: ${clientData.domain}`);

    // Submit to both Airtable and Notion in parallel
    const [airtableResult, notionResult] = await Promise.allSettled([
        submitToAirtable({ clientData, competitors, likedPosts, customUrls, compData }),
        submitToNotion({ clientData, competitors, likedPosts, customUrls, compData })
    ]);

    const response = {
        status: 'success',
        airtable: airtableResult.status === 'fulfilled'
            ? airtableResult.value
            : { error: airtableResult.reason?.message || 'Airtable failed' },
        notion: notionResult.status === 'fulfilled'
            ? notionResult.value
            : { error: notionResult.reason?.message || 'Notion failed' }
    };

    // Log results
    console.log(`[BTA] Airtable: ${airtableResult.status}`);
    console.log(`[BTA] Notion: ${notionResult.status}`);

    // Return success even if one failed (data is preserved in the other)
    if (airtableResult.status === 'rejected' && notionResult.status === 'rejected') {
        return res.status(500).json({
            error: 'Both destinations failed',
            airtable: response.airtable,
            notion: response.notion
        });
    }

    res.json(response);
});

// ============================================
// 6. GET CLIENTS
// ============================================
app.get('/api/clients', async (req, res) => {
    try {
        const clients = await getClientsFromAirtable();
        res.json({ status: 'success', count: clients.length, clients });
    } catch (error) {
        console.error('[BTA] Error fetching clients:', error.message);
        res.status(500).json({ error: 'Failed to fetch clients', details: error.message });
    }
});

// ============================================
// 7. ELEVENLABS: Get signed URL for conversation
// ============================================
app.get('/api/elevenlabs/session', async (req, res) => {
    const apiKey = process.env.ELEVEN_LABS_API_KEY;
    const agentId = process.env.ELEVEN_LABS_AGENT_ID;

    if (!apiKey || !agentId) {
        return res.status(500).json({
            error: 'ElevenLabs not configured',
            details: 'Missing ELEVEN_LABS_API_KEY or ELEVEN_LABS_AGENT_ID'
        });
    }

    try {
        console.log('[ElevenLabs] Generating signed URL...');
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
            {
                method: 'GET',
                headers: { 'xi-api-key': apiKey }
            }
        );

        if (!response.ok) {
            const error = await response.text();
            console.error('[ElevenLabs] API error:', error);
            return res.status(response.status).json({ error: 'ElevenLabs API error', details: error });
        }

        const data = await response.json();
        console.log('[ElevenLabs] Signed URL generated successfully');
        res.json({ signedUrl: data.signed_url });
    } catch (error) {
        console.error('[ElevenLabs] Error:', error.message);
        res.status(500).json({ error: 'Failed to get signed URL', details: error.message });
    }
});

// ============================================
// 9. ELEVENLABS CONTEXT: Provide full context for voice calls
// ============================================
app.get('/api/elevenlabs/context/:token', (req, res) => {
    const data = formTokens.get(req.params.token);
    if (!data) {
        return res.status(404).json({ error: 'Form not found or expired' });
    }

    // Build comprehensive context for the voice agent
    const clientData = data.clientData || {};
    const competitors = data.competitors || [];

    // Format competitor information for voice agent
    const competitorSummaries = competitors.map(comp => {
        return `${comp.name || comp.domain}: ${comp.reason || 'Direct competitor'}`;
    }).join('. ');

    // Build context object with dynamic variables for ElevenLabs
    const context = {
        // Basic client info
        client_name: data.clientName || clientData.name || data.domain,
        client_domain: data.domain,

        // Company details from scraped data
        client_usp: clientData.usp || 'Not available',
        client_icp: clientData.icp || 'Not available',
        client_industry: clientData.industry || 'Not available',
        client_niche: clientData.niche || 'Not available',
        client_about: clientData.about || 'Not available',

        // Features and integrations
        client_features: (clientData.features || []).join(', ') || 'Not available',
        client_integrations: (clientData.integrations || []).join(', ') || 'Not available',

        // Competitor information
        competitor_count: competitors.length,
        competitor_names: competitors.map(c => c.name || c.domain).join(', ') || 'None identified',
        competitor_details: competitorSummaries || 'No competitor details available',

        // Full data for advanced use
        full_client_data: JSON.stringify(clientData),
        full_competitor_data: JSON.stringify(competitors)
    };

    console.log(`[ElevenLabs] Context requested for ${context.client_name}`);
    console.log(`[ElevenLabs] Providing ${Object.keys(context).length} dynamic variables`);

    res.json(context);
});

// ============================================
// 8. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`[BTA Backend] Running on port ${PORT}`);
    console.log(`  POST /api/onboard            - Research a domain via AI`);
    console.log(`  POST /api/blogs              - Find blog posts via AI`);
    console.log(`  POST /api/sitemap            - Sitemap info (minimal)`);
    console.log(`  POST /api/form/create         - Generate shareable form link`);
    console.log(`  GET  /api/form/:token         - Get form info`);
    console.log(`  POST /api/form/:token/submit  - Client submits form`);
    console.log(`  POST /api/submit              - Direct submit to Airtable`);
    console.log(`  GET  /api/clients             - List all clients`);
    console.log(`  GET  /api/health              - Health check`);
});
