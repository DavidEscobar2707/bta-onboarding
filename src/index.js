const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { researchDomain, researchCompetitor } = require('./aiService');
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

function createLatencyTracker(operation, domain = 'n/a') {
    const startedAt = Date.now();
    const requestId = uuidv4().slice(0, 8);
    return {
        requestId,
        done: (status = 'ok', extra = {}) => {
            const latencyMs = Date.now() - startedAt;
            console.log(`[METRICS] op=${operation} requestId=${requestId} domain=${domain} latencyMs=${latencyMs} status=${status} extra=${JSON.stringify(extra)}`);
        }
    };
}

// ============================================
// 1. ONBOARD: Research a domain
// ============================================
app.post('/api/onboard', async (req, res) => {
    const { domain, findBlogs = false, competitors = [] } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });
    const tracker = createLatencyTracker('onboard', domain);

    try {
        console.log(`[BTA] Researching: ${domain}`);

        const result = await researchDomain(domain);

        if (!result) {
            throw new Error("AI research failed.");
        }

        const { data: aiData, competitors: detectedCompetitors, timings = {} } = result;
        const shouldFindBlogs = String(findBlogs).toLowerCase() !== 'false';
        const blogPosts = [];
        if (shouldFindBlogs) {
            console.log(`[BTA] findBlogs=true received, but blog search is deferred until competitor research is completed.`);
        }

        console.log(`[BTA] Returning ${detectedCompetitors.length} competitors`);

        const name = aiData.name || domain.replace(/\.(com|io|net|org).*/, '');

        res.json({
            domain,
            name: name.charAt(0).toUpperCase() + name.slice(1),
            status: 'success',
            data: aiData,
            competitors: detectedCompetitors,
            blogPosts
        });
        tracker.done('ok', {
            competitors: detectedCompetitors.length,
            blogs: blogPosts.length,
            findBlogs: shouldFindBlogs,
            ...timings
        });
    } catch (error) {
        console.error('[BTA] Error:', error.message);
        tracker.done('error', { error: error.message });
        res.status(500).json({ error: 'Failed to research domain', details: error.message });
    }
});

// ============================================
// 2. BLOGS: Find blog posts via AI (replaces scraper)
// ============================================
app.post('/api/blogs', async (req, res) => {
    const { domain, limit = 20 } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain is required' });
    const tracker = createLatencyTracker('blogs', domain);

    try {
        console.log(`[BTA] Finding blog posts for: ${domain}`);
        const blogPosts = await getBlogPosts(domain, limit);
        res.json({ domain, status: 'success', count: blogPosts.length, blogPosts });
        tracker.done('ok', { count: blogPosts.length });
    } catch (error) {
        console.error('[BTA] Blog error:', error.message);
        tracker.done('error', { error: error.message });
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

    console.log(`[BTA] Form link created for ${domain} | token: ${token} | clientData: ${clientData ? 'YES (' + Object.keys(clientData).join(',') + ')' : 'NO'} | competitors: ${(competitors || []).length} | competitorDetails: ${Object.keys(competitorDetails || {}).length} | blogPosts: ${(blogPosts || []).length}`);

    res.json({ status: 'success', token });
});

// Get form info by token (frontend calls this to show the form)
app.get('/api/form/:token', (req, res) => {
    const data = formTokens.get(req.params.token);
    if (!data) return res.status(404).json({ error: 'Form not found or expired' });

    res.json({ status: 'success', ...data });
});

// ============================================
// RESEARCH COMPETITOR: Deep research with 3 prompts
// ============================================
app.post('/api/research/competitor', async (req, res) => {
    const { competitorDomain, clientDomain, clientContext } = req.body;
    if (!competitorDomain) return res.status(400).json({ error: 'Competitor domain is required' });
    const tracker = createLatencyTracker('research_competitor', competitorDomain);

    try {
        console.log(`[BTA] Deep research for competitor: ${competitorDomain}`);

        const aiData = await researchCompetitor(competitorDomain, clientContext || null);

        if (!aiData) {
            throw new Error("AI research failed for competitor");
        }

        res.json({
            domain: competitorDomain,
            status: 'success',
            data: aiData
        });
        tracker.done('ok');
    } catch (error) {
        console.error('[BTA] Competitor research error:', error.message);
        tracker.done('error', { error: error.message });
        res.status(500).json({ error: 'Failed to research competitor', details: error.message });
    }
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
            compData: req.body.compData || {},
            sitemapData: req.body.sitemapData || {},
            elevenLabsData: req.body.elevenLabsData || {},
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
    const { clientData, competitors, likedPosts, customUrls, compData, sitemapData, elevenLabsData } = req.body;
    if (!clientData) return res.status(400).json({ error: 'Client data is required' });
    const tracker = createLatencyTracker('submit', clientData?.domain || 'unknown');

    console.log(`[BTA] Submitting to Airtable + Notion: ${clientData.domain}`);

    const submitPayload = { clientData, competitors, likedPosts, customUrls, compData, sitemapData, elevenLabsData };

    // Submit to both Airtable and Notion in parallel
    const [airtableResult, notionResult] = await Promise.allSettled([
        submitToAirtable(submitPayload),
        submitToNotion(submitPayload)
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
        tracker.done('error', { airtable: 'rejected', notion: 'rejected' });
        return res.status(500).json({
            error: 'Both destinations failed',
            airtable: response.airtable,
            notion: response.notion
        });
    }

    tracker.done('ok', {
        airtable: airtableResult.status,
        notion: notionResult.status
    });
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
    const tracker = createLatencyTracker('elevenlabs_session', 'voice');

    if (!apiKey || !agentId) {
        tracker.done('error', { reason: 'missing_env' });
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
            tracker.done('error', { status: response.status });
            return res.status(response.status).json({ error: 'ElevenLabs API error', details: error });
        }

        const data = await response.json();
        console.log('[ElevenLabs] Signed URL generated successfully');
        tracker.done('ok');
        res.json({ signedUrl: data.signed_url });
    } catch (error) {
        console.error('[ElevenLabs] Error:', error.message);
        tracker.done('error', { reason: error.message });
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

    // Access data from clientData.data (new structure after research rewrite)
    const d = clientData.data || clientData;

    // Build human-readable client context (NOT JSON)
    const contextLines = [];
    contextLines.push(`COMPANY NAME: ${d.name || clientData.name || data.clientName || data.domain}`);
    contextLines.push(`DOMAIN: ${data.domain}`);
    if (d.about) contextLines.push(`ABOUT: ${d.about}`);
    if (d.usp) contextLines.push(`USP (Unique Selling Proposition): ${d.usp}`);
    if (d.icp) contextLines.push(`ICP (Ideal Customer Profile): ${d.icp}`);
    if (d.industry) contextLines.push(`INDUSTRY: ${d.industry}`);
    if (d.niche) contextLines.push(`NICHE: ${d.niche}`);
    if (d.tone) contextLines.push(`BRAND TONE: ${d.tone}`);

    // Limit features to first 20 to avoid overwhelming context
    if (Array.isArray(d.features) && d.features.length > 0) {
        const features = d.features.slice(0, 20);
        contextLines.push(`FEATURES (top ${features.length}): ${features.join(', ')}`);
    }

    // Limit integrations to first 15
    if (Array.isArray(d.integrations) && d.integrations.length > 0) {
        const integrations = d.integrations.slice(0, 15);
        contextLines.push(`INTEGRATIONS (top ${integrations.length}): ${integrations.join(', ')}`);
    }

    // Pricing - limit to first 5 tiers
    if (Array.isArray(d.pricing) && d.pricing.length > 0) {
        const pricingSummary = d.pricing.slice(0, 5).map(p =>
            `${p.tier}: ${p.price}${p.period || ''}`
        ).join(' | ');
        contextLines.push(`PRICING: ${pricingSummary}`);
    }

    // Founders - limit to first 5
    if (Array.isArray(d.founders) && d.founders.length > 0) {
        const foundersSummary = d.founders.slice(0, 5).map(f =>
            `${f.name} (${f.role})${f.background ? ' - ' + f.background.substring(0, 100) : ''}`
        ).join('; ');
        contextLines.push(`FOUNDERS: ${foundersSummary}`);
    }

    // Compliance
    if (Array.isArray(d.compliance) && d.compliance.length > 0) {
        contextLines.push(`COMPLIANCE: ${d.compliance.join(', ')}`);
    }

    // Reviews - limit to first 5
    if (Array.isArray(d.reviews) && d.reviews.length > 0) {
        const reviewsSummary = d.reviews.slice(0, 5).map(r =>
            `${r.platform}: ${r.score}/5 (${r.count} reviews)`
        ).join(' | ');
        contextLines.push(`REVIEWS: ${reviewsSummary}`);
    }

    // Support
    if (d.support) {
        const supportText = typeof d.support === 'string' ? d.support : JSON.stringify(d.support);
        contextLines.push(`SUPPORT: ${supportText.substring(0, 200)}`);
    }

    // Limitations - limit to first 5
    if (d.limitations?.length > 0) {
        contextLines.push(`KNOWN LIMITATIONS: ${d.limitations.slice(0, 5).join('; ')}`);
    }

    // Blog topics - limit to first 10
    if (d.blogTopics?.length > 0) {
        contextLines.push(`BLOG TOPICS: ${d.blogTopics.slice(0, 10).join(', ')}`);
    }

    // Build human-readable competitor summary (limit to first 8 competitors)
    let competitorSummary = 'No competitors identified yet.';
    if (competitors.length > 0) {
        const limitedCompetitors = competitors.slice(0, 8);
        const competitorLines = limitedCompetitors.map(comp => {
            let line = `- ${comp.name || comp.domain}`;
            if (comp.reason) line += `: ${comp.reason.substring(0, 150)}`;
            if (comp.differentiator) line += `. Differentiator: ${comp.differentiator.substring(0, 150)}`;
            if (comp.strengthVsTarget) line += `. Strength: ${comp.strengthVsTarget.substring(0, 150)}`;
            if (comp.weaknessVsTarget) line += `. Weakness: ${comp.weaknessVsTarget.substring(0, 150)}`;
            return line;
        });
        competitorSummary = `Found ${competitors.length} competitor(s) (showing top ${limitedCompetitors.length}):\n${competitorLines.join('\n')}`;
    }

    // Final context object with exact variable names for ElevenLabs prompt
    let clientContext = contextLines.join('\n');

    // Hard limit to 8000 chars for client_context (ElevenLabs limit)
    if (clientContext.length > 8000) {
        clientContext = clientContext.substring(0, 7997) + '...';
        console.log(`[ElevenLabs] Warning: client_context truncated from ${contextLines.join('\n').length} to 8000 chars`);
    }

    // Hard limit to 6000 chars for competitor_summary
    if (competitorSummary.length > 6000) {
        competitorSummary = competitorSummary.substring(0, 5997) + '...';
        console.log(`[ElevenLabs] Warning: competitor_summary truncated to 6000 chars`);
    }

    const context = {
        client_name: d.name || clientData.name || data.clientName || data.domain,
        client_context: clientContext,
        competitor_summary: competitorSummary
    };

    console.log(`[ElevenLabs] Context for ${context.client_name}: ${contextLines.length} data points, ${competitors.length} competitors`);
    console.log(`[ElevenLabs] Sizes - client_context: ${clientContext.length} chars, competitor_summary: ${competitorSummary.length} chars`);

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
