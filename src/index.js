const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { generateFullResearch, perplexityCompetitorDeepResearch } = require('./aiService');
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
// Normalize AI data so all fields match what the frontend expects
// (prevents React error #31: objects rendered as children)
// ============================================
function normalizeAiData(data) {
    if (!data) return data;
    const d = { ...data };

    // support: object {channels, hours, notes} → string
    if (d.support && typeof d.support === 'object') {
        const parts = [];
        if (Array.isArray(d.support.channels) && d.support.channels.length) {
            parts.push(`Channels: ${d.support.channels.join(', ')}`);
        }
        if (d.support.hours) parts.push(`Hours: ${d.support.hours}`);
        if (d.support.notes) parts.push(d.support.notes);
        d.support = parts.join('. ') || '';
    }

    // icp: object {buyerPersona, companySize, industries, triggerEvents} → string
    if (d.icp && typeof d.icp === 'object') {
        const parts = [];
        if (d.icp.buyerPersona) parts.push(d.icp.buyerPersona);
        if (d.icp.companySize) parts.push(d.icp.companySize);
        if (Array.isArray(d.icp.industries) && d.icp.industries.length) {
            parts.push(d.icp.industries.join(', '));
        }
        d.icp = parts.join(' | ') || '';
    }

    // funding: object {totalRaised, lastRound, investors, stage} → string
    if (d.funding && typeof d.funding === 'object') {
        const parts = [];
        if (d.funding.totalRaised) parts.push(d.funding.totalRaised);
        if (d.funding.lastRound) parts.push(d.funding.lastRound);
        if (d.funding.stage) parts.push(d.funding.stage);
        d.fundingTotal = parts.join(' — ') || d.fundingTotal || '';
        delete d.funding;
    }

    // pricing: object {model, tiers, ...} → array of tiers
    if (d.pricing && !Array.isArray(d.pricing) && typeof d.pricing === 'object') {
        d.pricing = Array.isArray(d.pricing.tiers) ? d.pricing.tiers : [];
    }

    // features: array of {category, items} → flat array of strings
    if (Array.isArray(d.features) && d.features.length > 0 && d.features[0]?.items) {
        d.features = d.features.flatMap(f =>
            Array.isArray(f.items) ? f.items : [f]
        );
    }

    return d;
}

// ============================================
// 1. ONBOARD: Research a domain via LLM
// ============================================
app.post('/api/onboard', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    try {
        console.log(`[BTA] Full research pipeline for: ${domain}`);
        const research = await generateFullResearch(domain);

        const normalized = normalizeAiData(research.companyData);
        const name = normalized.name || domain.replace(/\.(com|io|net|org).*/, '');

        // Normalize competitor details too
        const normalizedCompDetails = {};
        for (const [compDomain, detail] of Object.entries(research.competitorDetails || {})) {
            normalizedCompDetails[compDomain] = normalizeAiData(detail);
        }

        console.log(`[BTA] Research complete for ${domain}: about=${!!normalized.about}, features=${normalized.features?.length || 0}, competitors=${research.competitors?.length || 0}, competitorDetails=${Object.keys(normalizedCompDetails).length}, blogs=${research.blogPosts?.length || 0}`);

        res.json({
            domain,
            name: name.charAt(0).toUpperCase() + name.slice(1),
            status: 'success',
            data: normalized,
            blogPosts: research.blogPosts || [],
            competitors: research.competitors || [],
            competitorDetails: normalizedCompDetails,
        });
    } catch (error) {
        console.error('[BTA] Error:', error.message);
        res.status(500).json({ error: 'Failed to research domain', details: error.message });
    }
});

// ============================================
// 1.5 DEEP RESEARCH: Lazy load competitor analysis
// ============================================
app.post('/api/research/competitor', async (req, res) => {
    const { competitorDomain, clientDomain, niche } = req.body;
    if (!competitorDomain || !clientDomain) return res.status(400).json({ error: 'Missing domains' });

    try {
        console.log(`[BTA] Lazy deep research for: ${competitorDomain}`);
        const data = await perplexityCompetitorDeepResearch(competitorDomain, clientDomain, niche || 'software');
        const normalized = normalizeAiData(data);
        res.json({ status: 'success', domain: competitorDomain, data: normalized });
    } catch (error) {
        console.error(`[BTA] Deep research error for ${competitorDomain}:`, error.message);
        res.status(500).json({ error: 'Deep research failed', details: error.message });
    }
});
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
    const { domain, clientName, clientData, competitors, competitorDetails, blogPosts } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });

    const token = uuidv4();
    const tokenData = {
        domain,
        clientName: clientName || domain,
        clientData: clientData || null,
        competitors: competitors || [],
        competitorDetails: competitorDetails || {},
        blogPosts: blogPosts || [],
        createdAt: new Date(),
    };
    formTokens.set(token, tokenData);

    console.log(`[BTA] Form link created for ${domain} | token: ${token} | clientData: ${clientData ? 'YES (' + Object.keys(clientData).join(',') + ')' : 'NO'} | competitors: ${(competitors || []).length} | competitorDetails: ${Object.keys(competitorDetails || {}).length} | blogs: ${(blogPosts || []).length}`);

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
// Variables match the ElevenLabs prompt: client_name, client_context, competitor_summary
// ============================================
app.get('/api/elevenlabs/context/:token', (req, res) => {
    const data = formTokens.get(req.params.token);
    if (!data) {
        return res.status(404).json({ error: 'Form not found or expired' });
    }

    const clientData = data.clientData || {};
    const competitors = data.competitors || [];
    const competitorDetails = data.competitorDetails || {};

    // Build human-readable client context (NOT JSON)
    const contextLines = [];
    contextLines.push(`COMPANY NAME: ${clientData.name || data.clientName || data.domain}`);
    contextLines.push(`DOMAIN: ${data.domain}`);
    if (clientData.about) contextLines.push(`ABOUT: ${clientData.about}`);
    if (clientData.usp) contextLines.push(`USP (Unique Selling Proposition): ${clientData.usp}`);
    if (clientData.icp) contextLines.push(`ICP (Ideal Customer Profile): ${clientData.icp}`);
    if (clientData.industry) contextLines.push(`INDUSTRY: ${clientData.industry}`);
    if (clientData.niche) contextLines.push(`NICHE: ${clientData.niche}`);
    if (clientData.tone) contextLines.push(`BRAND TONE: ${clientData.tone}`);

    if (Array.isArray(clientData.features) && clientData.features.length > 0) {
        contextLines.push(`FEATURES: ${clientData.features.join(', ')}`);
    }
    if (Array.isArray(clientData.integrations) && clientData.integrations.length > 0) {
        contextLines.push(`INTEGRATIONS: ${clientData.integrations.join(', ')}`);
    }

    // Pricing
    if (Array.isArray(clientData.pricing) && clientData.pricing.length > 0) {
        const pricingSummary = clientData.pricing.map(p =>
            `${p.tier}: ${p.price}${p.period || ''}`
        ).join(' | ');
        contextLines.push(`PRICING: ${pricingSummary}`);
    }

    // Founders
    if (Array.isArray(clientData.founders) && clientData.founders.length > 0) {
        const foundersSummary = clientData.founders.map(f =>
            `${f.name} (${f.role})${f.background ? ' - ' + f.background : ''}`
        ).join('; ');
        contextLines.push(`FOUNDERS: ${foundersSummary}`);
    }

    // Compliance
    if (Array.isArray(clientData.compliance) && clientData.compliance.length > 0) {
        contextLines.push(`COMPLIANCE: ${clientData.compliance.join(', ')}`);
    }

    // Reviews
    if (Array.isArray(clientData.reviews) && clientData.reviews.length > 0) {
        const reviewsSummary = clientData.reviews.map(r =>
            `${r.platform}: ${r.score}/5 (${r.count} reviews)`
        ).join(' | ');
        contextLines.push(`REVIEWS: ${reviewsSummary}`);
    }

    // Support
    if (clientData.support) {
        contextLines.push(`SUPPORT: ${typeof clientData.support === 'string' ? clientData.support : JSON.stringify(clientData.support)}`);
    }

    // Limitations
    if (clientData.limitations?.length > 0) {
        contextLines.push(`KNOWN LIMITATIONS: ${clientData.limitations.join('; ')}`);
    }

    // Blog topics
    if (clientData.blogTopics?.length > 0) {
        contextLines.push(`BLOG TOPICS: ${clientData.blogTopics.join(', ')}`);
    }

    // Build enriched competitor summary with deep research data
    let competitorSummary = 'No competitors identified yet.';
    if (competitors.length > 0) {
        const competitorLines = competitors.map(comp => {
            const detail = competitorDetails[comp.domain];
            let line = `- ${comp.name || comp.domain} (${comp.domain}): ${comp.reason || 'competitor'}`;
            if (detail) {
                if (detail.usp) line += `\n  USP: ${detail.usp}`;
                if (detail.about) line += `\n  About: ${detail.about}`;
                if (Array.isArray(detail.features) && detail.features.length > 0) {
                    line += `\n  Key Features: ${detail.features.slice(0, 6).join(', ')}`;
                }
                if (Array.isArray(detail.pricing) && detail.pricing.length > 0) {
                    line += `\n  Pricing: ${detail.pricing.map(p => `${p.tier}: ${p.price}${p.period || ''}`).join(' | ')}`;
                }
                if (Array.isArray(detail.reviews) && detail.reviews.length > 0) {
                    line += `\n  Reviews: ${detail.reviews.map(r => `${r.platform}: ${r.score}/5`).join(', ')}`;
                }
                if (detail.strengthVsTarget) line += `\n  Strength vs client: ${detail.strengthVsTarget}`;
                if (detail.weaknessVsTarget) line += `\n  Weakness vs client: ${detail.weaknessVsTarget}`;
            } else {
                if (comp.differentiator) line += `. Differentiator: ${comp.differentiator}`;
            }
            return line;
        });
        competitorSummary = `Found ${competitors.length} competitor(s) with detailed research:\n${competitorLines.join('\n\n')}`;
    }

    // Final context object with exact variable names for ElevenLabs prompt
    const context = {
        client_name: data.clientName || clientData.name || data.domain,
        client_context: contextLines.join('\n'),
        competitor_summary: competitorSummary
    };

    console.log(`[ElevenLabs] Context for ${context.client_name}: ${contextLines.length} data points, ${competitors.length} competitors`);

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
