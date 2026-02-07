const axios = require('axios');

// Airtable API Configuration
const AIRTABLE_API_URL = 'https://api.airtable.com/v0';

/**
 * Submit client onboarding data to Airtable
 * Captures ALL scraped data from client and competitors
 * 
 * @param {Object} data - The complete onboarding data
 * @returns {Object} - Airtable record response
 */
async function submitToAirtable(data) {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;

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
        features: clientScraped.features || [],
        integrations: clientScraped.integrations || [],
        pricing: clientScraped.pricing || [],
        founders: clientScraped.founders || [],
        compliance: clientScraped.compliance || [],
        reviews: clientScraped.reviews || [],
        caseStudies: clientScraped.caseStudies || [],
        techStack: clientScraped.techStack || [],
        limitations: clientScraped.limitations || [],
        social: clientScraped.social || {},
        support: clientScraped.support || '',
        contact: clientScraped.contact || [],
        segments: clientScraped.segments || [],
        contentThemes: clientScraped.contentThemes || [],
        partnerships: clientScraped.partnerships || [],
        funding: clientScraped.funding || '',
        teamSize: clientScraped.teamSize || '',
        guarantees: clientScraped.guarantees || '',
        roadmap: clientScraped.roadmap || ''
    };

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

            // Full scraped data from competitor
            usp: compScrapedData.usp || '',
            icp: compScrapedData.icp || '',
            tone: compScrapedData.tone || '',
            about: compScrapedData.about || '',
            industry: compScrapedData.industry || '',
            features: compScrapedData.features || [],
            integrations: compScrapedData.integrations || [],
            pricing: compScrapedData.pricing || [],
            founders: compScrapedData.founders || [],
            compliance: compScrapedData.compliance || [],
            reviews: compScrapedData.reviews || [],
            caseStudies: compScrapedData.caseStudies || [],
            techStack: compScrapedData.techStack || [],
            limitations: compScrapedData.limitations || [],
            social: compScrapedData.social || {},
            support: compScrapedData.support || '',
            contact: compScrapedData.contact || []
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
        const response = await axios.post(
            `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
            { fields },
            {
                headers: {
                    'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('[Airtable] Record created successfully:', response.data.id);
        return {
            success: true,
            recordId: response.data.id,
            createdTime: response.data.createdTime
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

module.exports = { submitToAirtable, getClientsFromAirtable };
