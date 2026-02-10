const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { researchDomain, researchCompetitor, enrichDataReviewPostCall } = require('./aiService');
const { getBlogPosts, scrapeFullBlogContent } = require('./blogService');
const {
    submitToAirtable,
    getClientsFromAirtable,
    createOnboardingSession,
    getOnboardingSessionByToken
} = require('./airtableService');
const { submitToNotion } = require('./notionService');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const FORM_TOKEN_TTL_DAYS = Math.max(1, Number(process.env.FORM_TOKEN_TTL_DAYS || 3));
const BLOG_CACHE_TTL_MS = 86_400_000;
const BLOG_SCRAPE_TIMEOUT_MS = 6500;

// In-memory store for form tokens (maps token -> domain)
const formTokens = new Map();
const blogCache = new Map();

function normalizeDomainForCache(input) {
    if (!input) return null;
    try {
        const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
        const parsed = new URL(withProtocol);
        return parsed.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return String(input)
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .split('/')[0] || null;
    }
}

function buildBlogCacheKey(domain, limit) {
    const normalizedDomain = normalizeDomainForCache(domain) || String(domain || '').toLowerCase();
    const normalizedLimit = Math.max(1, Number(limit) || 20);
    return `${normalizedDomain}::${normalizedLimit}`;
}

function pruneExpiredBlogCache(now, ttlMs) {
    for (const [key, value] of blogCache.entries()) {
        if (!value?.cachedAt || (now - value.cachedAt) > ttlMs) {
            blogCache.delete(key);
        }
    }
}

function normalizeBlogInputUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return null;
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        return new URL(withProtocol).href;
    } catch {
        return null;
    }
}

function deriveTitleFromUrl(url) {
    try {
        const parsed = new URL(url);
        const slug = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return decodeURIComponent(slug)
            .replace(/[-_]+/g, ' ')
            .replace(/\.\w+$/, '')
            .trim()
            .split(' ')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ') || parsed.hostname;
    } catch {
        return 'Manual Blog';
    }
}

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

async function resolveTokenData(token) {
    const memoryData = formTokens.get(token);
    if (memoryData) {
        const expiresAtMs = memoryData.expiresAt ? Date.parse(memoryData.expiresAt) : Number.NaN;
        if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
            formTokens.delete(token);
        } else {
            return { source: 'memory', tokenData: memoryData };
        }
    }

    const persisted = await getOnboardingSessionByToken(token);
    if (!persisted) return null;

    const session = persisted.session || {};
    const persistedExpiresAtMs = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
    if (Number.isFinite(persistedExpiresAtMs) && Date.now() > persistedExpiresAtMs) {
        return null;
    }
    if (String(session.status || '').toUpperCase() === 'COMPLETED') {
        return null;
    }

    const payload = persisted.formPayload || {};
    const tokenData = {
        domain: payload.domain || persisted.domain,
        clientName: payload.clientName || persisted.clientName || persisted.domain,
        clientData: payload.clientData || null,
        competitors: payload.competitors || [],
        competitorDetails: payload.competitorDetails || {},
        blogPosts: payload.blogPosts || [],
        createdAt: session.createdAt || new Date().toISOString(),
        expiresAt: session.expiresAt || null,
        persistedRecordId: persisted.recordId
    };
    formTokens.set(token, tokenData);
    return { source: 'airtable', tokenData };
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
    const ttlMs = BLOG_CACHE_TTL_MS;
    const cacheKey = buildBlogCacheKey(domain, limit);
    const now = Date.now();

    pruneExpiredBlogCache(now, ttlMs);

    try {
        console.log(`[BTA] Finding blog posts for: ${domain}`);
        const cached = blogCache.get(cacheKey);
        if (cached && Array.isArray(cached.blogPosts) && (now - cached.cachedAt) <= ttlMs) {
            const cacheAgeMs = now - cached.cachedAt;
            console.log(`[BTA] Blog cache hit for ${domain} | key=${cacheKey} | ageMs=${cacheAgeMs}`);
            res.json({
                domain,
                status: 'success',
                count: cached.blogPosts.length,
                blogPosts: cached.blogPosts,
                cache: { hit: true, ageMs: cacheAgeMs }
            });
            tracker.done('ok', { count: cached.blogPosts.length, cache_hit: true, cache_age_ms: cacheAgeMs });
            return;
        }

        console.log(`[BTA] Blog cache miss for ${domain} | key=${cacheKey}`);
        const blogPosts = await getBlogPosts(domain, limit);
        blogCache.set(cacheKey, { blogPosts, cachedAt: Date.now() });
        res.json({
            domain,
            status: 'success',
            count: blogPosts.length,
            blogPosts,
            cache: { hit: false, ageMs: 0 }
        });
        tracker.done('ok', { count: blogPosts.length, cache_hit: false, cache_miss: true, cache_age_ms: 0 });
    } catch (error) {
        console.error('[BTA] Blog error:', error.message);
        tracker.done('error', { error: error.message });
        res.status(500).json({ error: 'Failed to find blog posts', details: error.message, blogPosts: [] });
    }
});

// ============================================
// 2b. BLOGS MANUAL: Add a single manual blog URL
// ============================================
app.post('/api/blogs/manual', async (req, res) => {
    const { url, domain = null } = req.body || {};
    const normalizedUrl = normalizeBlogInputUrl(url);
    if (!normalizedUrl) return res.status(400).json({ error: 'Valid blog URL is required' });
    const tracker = createLatencyTracker('blogs_manual', domain || normalizedUrl);
    const scrapeTimeoutMs = BLOG_SCRAPE_TIMEOUT_MS;

    try {
        console.log(`[BTA] Manual blog add requested: ${normalizedUrl}`);
        const scraped = await scrapeFullBlogContent(normalizedUrl, scrapeTimeoutMs);

        const blogPost = {
            id: `manual-${Date.now()}`,
            url: normalizedUrl,
            title: scraped?.title || deriveTitleFromUrl(normalizedUrl),
            description: scraped?.description || 'Added manually by user.',
            content: scraped?.content || '',
            fullContent: scraped?.fullContent || scraped?.content || '',
            author: scraped?.author || '',
            date: scraped?.publishDate || null,
            image: scraped?.image || null,
            wordCount: scraped?.wordCount || 0,
            readingTime: scraped?.readingTime || 0,
            manual: true,
            source: 'manual'
        };

        res.json({ status: 'success', blogPost });
        tracker.done('ok', { scraped: !!scraped, url: normalizedUrl });
    } catch (error) {
        console.error('[BTA] Manual blog add failed:', error.message);
        tracker.done('error', { error: error.message });
        res.status(500).json({ error: 'Failed to add manual blog URL', details: error.message });
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
app.post('/api/form/create', async (req, res) => {
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
        expiresAt: new Date(Date.now() + FORM_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    try {
        const persisted = await createOnboardingSession({
            token,
            domain,
            clientName: tokenData.clientName,
            formPayload: tokenData,
            ttlDays: FORM_TOKEN_TTL_DAYS
        });

        tokenData.persistedRecordId = persisted.recordId;
        formTokens.set(token, tokenData);
        console.log(`[BTA] Form link created for ${domain} | token: ${token} | persistedRecordId: ${persisted.recordId} | ttlDays: ${FORM_TOKEN_TTL_DAYS} | clientData: ${clientData ? 'YES (' + Object.keys(clientData).join(',') + ')' : 'NO'} | competitors: ${(competitors || []).length} | competitorDetails: ${Object.keys(competitorDetails || {}).length} | blogPosts: ${(blogPosts || []).length}`);
        res.json({ status: 'success', token, ttlDays: FORM_TOKEN_TTL_DAYS });
    } catch (error) {
        console.error('[BTA] Failed to persist form token in Airtable:', error.message);
        res.status(500).json({
            error: 'Failed to create form link',
            details: `Token persistence failed in Airtable: ${error.message}`
        });
    }
});

// Get form info by token (frontend calls this to show the form)
app.get('/api/form/:token', async (req, res) => {
    try {
        const resolved = await resolveTokenData(req.params.token);
        if (!resolved?.tokenData) return res.status(404).json({ error: 'Form not found or expired' });
        res.json({ status: 'success', ...resolved.tokenData });
    } catch (error) {
        console.error('[BTA] Form lookup error:', error.message);
        res.status(500).json({ error: 'Failed to load form', details: error.message });
    }
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

// ============================================
// RESEARCH POST-CALL ENRICHMENT: Fill Data Review gaps using interview + blogs
// ============================================
app.post('/api/research/data-review-autofill', async (req, res) => {
    const { clientData, compData = {}, competitors = [], elevenLabsData = {} } = req.body || {};
    if (!clientData?.domain) {
        return res.status(400).json({ error: 'clientData.domain is required' });
    }
    const tracker = createLatencyTracker('research_data_review_autofill', clientData.domain);
    try {
        const result = await enrichDataReviewPostCall({
            clientData,
            compData,
            competitors,
            elevenLabsData
        });
        tracker.done('ok', {
            competitors: Array.isArray(competitors) ? competitors.length : 0,
            failedCompetitors: result.failedCompetitors?.length || 0
        });
        res.json({
            status: 'success',
            ...result
        });
    } catch (error) {
        tracker.done('error', { error: error.message });
        console.error('[BTA] Data review autofill error:', error.message);
        res.status(500).json({ error: 'Failed to autofill data review', details: error.message });
    }
});

app.post('/api/research/context-summary', async (req, res) => {
    const { clientData, elevenLabsData = {} } = req.body || {};
    if (!clientData?.domain) {
        return res.status(400).json({ error: 'clientData.domain is required' });
    }
    try {
        const blogPosts = Array.isArray(clientData?.blogPosts) ? clientData.blogPosts.slice(0, 10) : [];
        const transcript = Array.isArray(elevenLabsData?.transcript) ? elevenLabsData.transcript.slice(-16) : [];
        const transcriptSummary = transcript.map((m) => `${m?.role || 'unknown'}: ${String(m?.text || '').slice(0, 260)}`).join('\n');
        const blogsSummary = blogPosts.map((b) => `${b?.title || 'untitled'} | ${b?.url || ''}`).join('\n');
        res.json({
            status: 'success',
            transcriptSummary: transcriptSummary || null,
            blogsSummary: blogsSummary || null
        });
    } catch (error) {
        console.error('[BTA] Context summary error:', error.message);
        res.status(500).json({ error: 'Failed to summarize context', details: error.message });
    }
});

// Client submits the form
app.post('/api/form/:token/submit', async (req, res) => {
    try {
        const resolved = await resolveTokenData(req.params.token);
        const tokenData = resolved?.tokenData;
        if (!tokenData) return res.status(404).json({ error: 'Form not found or expired' });

        const airtableResult = await submitToAirtable({
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
        }, {
            existingRecordId: tokenData.persistedRecordId || null,
            sessionMeta: {
                kind: 'onboarding_session',
                token: req.params.token,
                status: 'COMPLETED',
                createdAt: tokenData.createdAt ? new Date(tokenData.createdAt).toISOString() : new Date().toISOString(),
                completedAt: new Date().toISOString(),
                expiresAt: null
            },
            verifyWrite: true
        });

        formTokens.delete(req.params.token);

        let notionResult = null;
        let notionError = null;
        try {
            notionResult = await submitToNotion({
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
        } catch (error) {
            notionError = error.message;
            console.warn('[BTA] Notion submit failed after Airtable success:', error.message);
        }

        res.json({
            status: notionError ? 'success_with_notion_pending' : 'success',
            message: notionError
                ? 'Saved to Airtable. Notion sync is pending retry.'
                : 'Saved to Airtable and Notion',
            finalStatus: notionError ? 'airtable_saved_notion_pending' : 'completed',
            airtable: airtableResult,
            notion: notionError ? { success: false, error: notionError } : notionResult
        });
    } catch (error) {
        console.error('[BTA] Form submit error:', error.message);
        res.status(500).json({ error: 'Failed to submit', details: error.message });
    }
});

// ============================================
// 5. SUBMIT: Direct submit to Airtable (from dashboard)
// ============================================
app.post('/api/submit', async (req, res) => {
    const { clientData, competitors, likedPosts, customUrls, compData, sitemapData, elevenLabsData, formToken } = req.body;
    if (!clientData) return res.status(400).json({ error: 'Client data is required' });
    const tracker = createLatencyTracker('submit', clientData?.domain || 'unknown');

    console.log(`[BTA] Submitting final payload. domain=${clientData.domain} formToken=${formToken ? 'yes' : 'no'}`);

    let resolvedToken = null;
    if (formToken) {
        try {
            resolvedToken = await resolveTokenData(formToken);
        } catch (error) {
            console.warn('[BTA] Token resolve failed in /api/submit:', error.message);
        }
    }

    const submitPayload = { clientData, competitors, likedPosts, customUrls, compData, sitemapData, elevenLabsData };

    try {
        const airtableResult = await submitToAirtable(submitPayload, {
            existingRecordId: resolvedToken?.tokenData?.persistedRecordId || null,
            sessionMeta: formToken
                ? {
                    kind: 'onboarding_session',
                    token: formToken,
                    status: 'COMPLETED',
                    createdAt: resolvedToken?.tokenData?.createdAt
                        ? new Date(resolvedToken.tokenData.createdAt).toISOString()
                        : new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    expiresAt: null
                }
                : null,
            verifyWrite: true
        });

        let notionResult = null;
        let notionError = null;
        try {
            notionResult = await submitToNotion(submitPayload);
        } catch (error) {
            notionError = error.message;
            console.warn('[BTA] Notion submit failed (non-blocking):', error.message);
        }

        if (formToken) {
            formTokens.delete(formToken);
        }

        tracker.done('ok', {
            airtable: 'fulfilled',
            airtableVerified: airtableResult.verified,
            notion: notionError ? 'rejected' : 'fulfilled'
        });
        return res.json({
            status: notionError ? 'success_with_notion_pending' : 'success',
            finalStatus: notionError ? 'airtable_saved_notion_pending' : 'completed',
            airtable: airtableResult,
            notion: notionError ? { success: false, error: notionError } : notionResult
        });
    } catch (error) {
        tracker.done('error', { airtable: 'rejected', error: error.message });
        return res.status(500).json({
            error: 'Airtable submission failed',
            details: error.message
        });
    }
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
app.get('/api/elevenlabs/context/:token', async (req, res) => {
    try {
        const resolved = await resolveTokenData(req.params.token);
        const data = resolved?.tokenData;
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
    } catch (error) {
        console.error('[BTA] ElevenLabs context error:', error.message);
        res.status(500).json({ error: 'Failed to build ElevenLabs context', details: error.message });
    }
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
