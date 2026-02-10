const axios = require('axios');

// Airtable API Configuration
const AIRTABLE_API_URL = 'https://api.airtable.com/v0';
const SESSION_KIND = 'onboarding_session';

function safeJsonParse(value, fallback = null) {
    if (!value || typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

/**
 * Submit client onboarding data to Airtable
 * Captures ALL scraped data from client and competitors
 * 
 * @param {Object} data - The complete onboarding data
 * @returns {Object} - Airtable record response
 */
async function submitToAirtable(data, options = {}) {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;
    const {
        existingRecordId = null,
        sessionMeta = null,
        verifyWrite = true
    } = options;

    // Validate environment variables
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
        console.error('[Airtable] Missing environment variables');
        throw new Error('Airtable configuration incomplete. Check AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and AIRTABLE_TABLE_NAME in .env');
    }

    // Extract client info
    const clientData = data.clientData || {};
    const clientScraped = clientData.data || {};

    // ============================================
    // CLIENT SCRAPED DATA (everything from AI analysis)
    // ============================================
    const clientInfo = {
        domain: clientData.domain || '',
        name: clientData.name || clientScraped.name || '',
        usp: clientScraped.usp || '',
        icp: clientScraped.icp || '',
        tone: clientScraped.tone || '',
        about: clientScraped.about || '',
        industry: clientScraped.industry || '',
        features: Array.isArray(clientScraped.features) ? clientScraped.features : [],
        integrations: Array.isArray(clientScraped.integrations) ? clientScraped.integrations : [],
        pricing: Array.isArray(clientScraped.pricing) ? clientScraped.pricing : [],
        founders: Array.isArray(clientScraped.founders) ? clientScraped.founders : [],
        compliance: Array.isArray(clientScraped.compliance) ? clientScraped.compliance : [],
        reviews: Array.isArray(clientScraped.reviews) ? clientScraped.reviews : [],
        caseStudies: Array.isArray(clientScraped.caseStudies) ? clientScraped.caseStudies : [],
        techStack: Array.isArray(clientScraped.techStack) ? clientScraped.techStack : [],
        limitations: Array.isArray(clientScraped.limitations) ? clientScraped.limitations : [],
        social: clientScraped.social || {},
        support: clientScraped.support || '',
        contact: Array.isArray(clientScraped.contact) ? clientScraped.contact : [],
        segments: Array.isArray(clientScraped.segments) ? clientScraped.segments : [],
        contentThemes: Array.isArray(clientScraped.contentThemes) ? clientScraped.contentThemes : [],
        partnerships: Array.isArray(clientScraped.partnerships) ? clientScraped.partnerships : [],
        funding: clientScraped.funding || '',
        teamSize: clientScraped.teamSize || '',
        guarantees: clientScraped.guarantees || '',
        roadmap: clientScraped.roadmap || '',
        // NEW FIELDS
        commonObjections: Array.isArray(clientScraped.commonObjections) ? clientScraped.commonObjections : [],
        notableCustomers: Array.isArray(clientScraped.notableCustomers) ? clientScraped.notableCustomers : [],
        searchesPerformed: Array.isArray(clientScraped.searchesPerformed) ? clientScraped.searchesPerformed : [],
        confidenceNotes: clientScraped.confidenceNotes || '',
        researchDate: clientScraped.researchDate || ''
    };
    if (sessionMeta && typeof sessionMeta === 'object') {
        clientInfo._session = sessionMeta;
    }

    // ============================================
    // COMPETITORS SCRAPED DATA (full detail for each)
    // ============================================
    const competitorsDetailed = (data.competitors || []).map(comp => {
        const compScrapedData = data.compData?.[comp.domain]?.data || {};
        return {
            // Basic info
            domain: comp.domain,
            name: comp.name || compScrapedData.name || '',
            reason: comp.reason || '',

            // Comparison fields (from Claude)
            differentiator: comp.differentiator || '',
            strengthVsTarget: comp.strengthVsTarget || '',
            weaknessVsTarget: comp.weaknessVsTarget || '',
            pricingComparison: comp.pricingComparison || '',

            // Full scraped data from competitor
            usp: compScrapedData.usp || '',
            icp: compScrapedData.icp || '',
            tone: compScrapedData.tone || '',
            about: compScrapedData.about || '',
            industry: compScrapedData.industry || '',
            features: Array.isArray(compScrapedData.features) ? compScrapedData.features : [],
            integrations: Array.isArray(compScrapedData.integrations) ? compScrapedData.integrations : [],
            pricing: Array.isArray(compScrapedData.pricing) ? compScrapedData.pricing : [],
            founders: Array.isArray(compScrapedData.founders) ? compScrapedData.founders : [],
            compliance: Array.isArray(compScrapedData.compliance) ? compScrapedData.compliance : [],
            reviews: Array.isArray(compScrapedData.reviews) ? compScrapedData.reviews : [],
            caseStudies: Array.isArray(compScrapedData.caseStudies) ? compScrapedData.caseStudies : [],
            techStack: Array.isArray(compScrapedData.techStack) ? compScrapedData.techStack : [],
            limitations: Array.isArray(compScrapedData.limitations) ? compScrapedData.limitations : [],
            social: compScrapedData.social || {},
            support: compScrapedData.support || '',
            contact: Array.isArray(compScrapedData.contact) ? compScrapedData.contact : []
        };
    });

    // ============================================
    // SELECTED BLOG POSTS (for style replication)
    // ============================================
    const selectedBlogs = (data.likedPosts || []).map(post => ({
        url: post.url || '',
        title: post.title || '',
        description: post.description || '',
        date: post.date || '',
        image: post.image || '',
        // Include any additional scraped content if available
        content: post.content || ''
    }));

    // ============================================
    // SITEMAP DATA
    // ============================================
    const sitemapInfo = data.sitemapData || {};

    // ============================================
    // ELEVENLABS DATA
    // ============================================
    const elevenLabsInfo = data.elevenLabsData || {};
    const transcriptText = (elevenLabsInfo.transcript || [])
        .map(msg => `[${msg.role}]: ${msg.text}`)
        .join('\n');

    // Helper: Convert array to pipe-delimited string (easier for Airtable AI)
    const toReadableList = (arr) => {
        if (!arr || !Array.isArray(arr)) return '';
        return arr.filter(Boolean).join(' | ');
    };

    // Build the record fields
    const fields = {
        // === CLIENT IDENTIFICATION ===
        'Client Domain': clientInfo.domain,
        'Client Name': clientInfo.name,

        // === CLIENT SCRAPED DATA (Individual fields for easy viewing) ===
        'Client USP': clientInfo.usp,
        'Client ICP': clientInfo.icp,
        'Client Industry': clientInfo.industry,
        'Client About': clientInfo.about,
        'Client Tone': clientInfo.tone,
        'Client Features': toReadableList(clientInfo.features),  // Pipe-delimited
        'Client Integrations': toReadableList(clientInfo.integrations),  // Pipe-delimited
        'Client Tech Stack': toReadableList(clientInfo.techStack),  // Pipe-delimited
        'Client Compliance': toReadableList(clientInfo.compliance),  // Pipe-delimited
        'Client Pricing': JSON.stringify(clientInfo.pricing),  // Complex, keep JSON
        'Client Reviews': JSON.stringify(clientInfo.reviews),  // Complex, keep JSON

        // === FULL CLIENT DATA (JSON backup of everything) ===
        'Client Full Data': JSON.stringify(clientInfo),

        // === COMPETITORS (Full detailed JSON) ===
        'Competitors Count': competitorsDetailed.length,
        'Competitors Names': competitorsDetailed.map(c => c.name).join(' | '),  // Quick reference
        'Competitors Data': JSON.stringify(competitorsDetailed),

        // === SELECTED BLOGS FOR STYLE ===
        'Selected Blogs Count': selectedBlogs.length,
        'Selected Blogs Titles': selectedBlogs.map(b => b.title).join(' | '),  // Quick reference
        'Selected Blogs': JSON.stringify(selectedBlogs),

        // === CUSTOM URLS ===
        'Custom URLs': toReadableList((data.customUrls || []).filter(u => u && u.trim() !== '')),

        // === ELEVENLABS CALL DATA ===
        'ElevenLabs Completed': elevenLabsInfo.completed ? 'Yes' : 'No',
        'ElevenLabs Duration Seconds': elevenLabsInfo.duration || 0,
        'ElevenLabs Messages Count': (elevenLabsInfo.transcript || []).length,
        'ElevenLabs Transcript': transcriptText,

        // === LLMs.txt (the only thing we need from sitemap) ===
        'Has LLMs TXT': sitemapInfo.llmsTxt ? 'Yes' : 'No',
        'LLMs TXT Content': sitemapInfo.llmsTxt || '',

        // === METADATA ===
        'Submitted At': new Date().toISOString().split('T')[0]
    };

    console.log('[Airtable] Submitting record for:', fields['Client Name'] || fields['Client Domain']);
    console.log('[Airtable] Client data fields:', Object.keys(clientInfo).length);
    console.log('[Airtable] Competitors:', competitorsDetailed.length);
    console.log('[Airtable] Selected blogs:', selectedBlogs.length);
    console.log('[Airtable] Has llms.txt:', sitemapInfo.llmsTxt ? 'Yes' : 'No');

    try {
        const baseUrl = `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
        const headers = {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
        };
        const response = existingRecordId
            ? await axios.patch(`${baseUrl}/${existingRecordId}`, { fields }, { headers })
            : await axios.post(baseUrl, { fields }, { headers });

        let verified = false;
        if (verifyWrite && response?.data?.id) {
            try {
                const verifyResponse = await axios.get(`${baseUrl}/${response.data.id}`, {
                    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
                });
                verified = Boolean(verifyResponse?.data?.id === response.data.id);
            } catch (verifyError) {
                console.warn('[Airtable] Write verification failed:', verifyError.message);
            }
        }

        console.log('[Airtable] Record created successfully:', response.data.id);
        return {
            success: true,
            recordId: response.data.id,
            createdTime: response.data.createdTime,
            verified,
            operation: existingRecordId ? 'update' : 'create'
        };
    } catch (error) {
        console.error('[Airtable] Error creating record:', error.response?.data || error.message);

        // Provide helpful error messages
        if (error.response?.status === 401) {
            throw new Error('Airtable authentication failed. Check your API key.');
        }
        if (error.response?.status === 404) {
            throw new Error('Airtable base or table not found. Check your Base ID and Table Name.');
        }
        if (error.response?.status === 422) {
            const fieldError = error.response.data?.error?.message || 'Unknown field error';
            throw new Error(`Airtable field error: ${fieldError}`);
        }

        throw new Error(`Airtable error: ${error.message}`);
    }
}

async function createOnboardingSession({
    token,
    domain,
    clientName,
    formPayload,
    ttlDays = 3
}) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (Math.max(1, Number(ttlDays) || 3) * 24 * 60 * 60 * 1000));
    const sessionMeta = {
        kind: SESSION_KIND,
        token,
        status: 'PENDING',
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        formPayload: formPayload || null
    };

    const result = await submitToAirtable({
        clientData: {
            domain,
            name: clientName || domain,
            data: {
                about: 'Onboarding session created. Waiting for client completion.'
            }
        },
        competitors: formPayload?.competitors || [],
        likedPosts: [],
        customUrls: [],
        compData: formPayload?.competitorDetails || {},
        sitemapData: {},
        elevenLabsData: {}
    }, {
        sessionMeta,
        verifyWrite: true
    });

    return {
        ...result,
        sessionMeta
    };
}

async function getOnboardingSessionByToken(token) {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
        throw new Error('Airtable configuration incomplete');
    }

    const baseUrl = `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    const filterByFormula = `FIND("${String(token).replace(/"/g, '\\"')}", {Client Full Data})`;

    const response = await axios.get(baseUrl, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` },
        params: { maxRecords: 10, filterByFormula }
    });

    for (const record of response?.data?.records || []) {
        const fields = record.fields || {};
        const fullData = safeJsonParse(fields['Client Full Data'], {});
        const session = fullData?._session;
        if (!session || session.kind !== SESSION_KIND || session.token !== token) continue;

        return {
            recordId: record.id,
            domain: fields['Client Domain'] || fullData?.domain || '',
            clientName: fields['Client Name'] || fullData?.name || '',
            session,
            formPayload: session.formPayload || null,
            fullData
        };
    }

    return null;
}

/**
 * Get all clients from Airtable
 * @returns {Array} - List of client records
 */
async function getClientsFromAirtable() {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
        throw new Error('Airtable configuration incomplete');
    }

    try {
        const response = await axios.get(
            `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
            {
                headers: {
                    'Authorization': `Bearer ${AIRTABLE_API_KEY}`
                },
                params: {
                    sort: [{ field: 'Submitted At', direction: 'desc' }]
                }
            }
        );

        return response.data.records.map(record => ({
            id: record.id,
            ...record.fields
        }));
    } catch (error) {
        console.error('[Airtable] Error fetching records:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    submitToAirtable,
    getClientsFromAirtable,
    createOnboardingSession,
    getOnboardingSessionByToken
};
