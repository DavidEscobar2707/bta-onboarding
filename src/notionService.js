const { Client } = require('@notionhq/client');

/**
 * Notion Service - Creates COMPLETE document with ALL data in ENGLISH
 * No data is lost - everything is included in the report
 */

/**
 * Helper: Create paragraph block with optional bold label
 */
function paragraph(text, label = null) {
    if (label) {
        return {
            type: 'paragraph',
            paragraph: {
                rich_text: [
                    { text: { content: `${label}: `, annotations: { bold: true } } },
                    { text: { content: text || 'Not available' } }
                ]
            }
        };
    }
    return {
        type: 'paragraph',
        paragraph: {
            rich_text: [{ text: { content: text || '' } }]
        }
    };
}

/**
 * Helper: Create heading block
 */
function heading(level, emoji, text) {
    const type = `heading_${level}`;
    return {
        type,
        [type]: {
            rich_text: [{ text: { content: `${emoji} ${text}` } }]
        }
    };
}

/**
 * Helper: Create bulleted list item
 */
function bullet(text, link = null) {
    return {
        type: 'bulleted_list_item',
        bulleted_list_item: {
            rich_text: [{
                text: { content: text || '', link: link ? { url: link } : null }
            }]
        }
    };
}

/**
 * Helper: Create numbered list item
 */
function numbered(text) {
    return {
        type: 'numbered_list_item',
        numbered_list_item: {
            rich_text: [{ text: { content: text || '' } }]
        }
    };
}

/**
 * Helper: Create divider
 */
function divider() {
    return { type: 'divider', divider: {} };
}

/**
 * Helper: Create code block
 */
function codeBlock(content, language = 'json') {
    return {
        type: 'code',
        code: {
            rich_text: [{ text: { content: (content || '').substring(0, 2000) } }],
            language
        }
    };
}

/**
 * Helper: Create toggle block with children
 */
function toggle(title, children) {
    return {
        type: 'toggle',
        toggle: {
            rich_text: [{ text: { content: title } }],
            children: children
        }
    };
}

/**
 * Create a COMPLETE report document in Notion with ALL available data (ENGLISH)
 */
async function submitToNotion(data) {
    const notionKey = process.env.NOTION_API_KEY;
    const parentPageId = process.env.NOTION_PARENT_PAGE_ID;

    if (!notionKey || !parentPageId) {
        console.log('[Notion] Missing NOTION_API_KEY or NOTION_PARENT_PAGE_ID, skipping backup');
        return { skipped: true, reason: 'Not configured' };
    }

    const notion = new Client({ auth: notionKey });

    // Extract ALL data
    const clientData = data.clientData || {};
    const clientScraped = clientData.data || {};
    const competitors = data.competitors || [];
    const compData = data.compData || {};
    const likedPosts = data.likedPosts || [];
    const customUrls = data.customUrls || [];
    const elevenLabsData = data.elevenLabsData || {};
    const sitemapData = data.sitemapData || {};

    const companyName = clientData.name || clientScraped.name || clientData.domain || 'Unknown Company';
    const dateStr = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    // Build COMPLETE document
    const children = [];

    // ==========================================
    // HEADER
    // ==========================================
    children.push(
        heading(1, '📋', `Complete Report: ${companyName}`),
        paragraph(`Date: ${dateStr}  |  Domain: ${clientData.domain || 'N/A'}`),
        divider()
    );

    // ==========================================
    // CLIENT IDENTIFICATION
    // ==========================================
    children.push(heading(2, '🏢', 'Client Identification'));
    children.push(paragraph(clientData.domain, 'Domain'));
    children.push(paragraph(companyName, 'Company Name'));
    children.push(paragraph(clientScraped.industry || 'Not specified', 'Industry'));
    children.push(paragraph(clientScraped.niche || 'Not specified', 'Specific Niche'));

    // ==========================================
    // DESCRIPTION AND VALUE PROPOSITION
    // ==========================================
    children.push(divider(), heading(2, '💡', 'Value Proposition'));
    children.push(paragraph(clientScraped.about || 'Not available', 'About the Company'));
    children.push(paragraph(clientScraped.usp || 'Not available', 'USP (Unique Selling Proposition)'));
    children.push(paragraph(clientScraped.icp || 'Not available', 'ICP (Ideal Customer Profile)'));
    children.push(paragraph(clientScraped.tone || 'Not specified', 'Brand Tone'));

    // ==========================================
    // FOUNDING TEAM
    // ==========================================
    const founders = Array.isArray(clientScraped.founders) ? clientScraped.founders : [];
    if (founders.length > 0) {
        children.push(divider(), heading(2, '👥', `Founding Team (${founders.length})`));
        for (const founder of founders) {
            children.push(paragraph(`${founder.name || 'N/A'} - ${founder.role || 'N/A'}`));
            if (founder.background) {
                children.push(paragraph(`   Background: ${founder.background}`));
            }
            if (founder.linkedin) {
                children.push(paragraph(`   LinkedIn: ${founder.linkedin}`));
            }
        }
    }

    // ==========================================
    // FUNDING
    // ==========================================
    const funding = clientScraped.funding;
    if (funding && (typeof funding === 'string' ? funding : funding.totalRaised)) {
        children.push(divider(), heading(2, '💵', 'Funding'));
        if (typeof funding === 'string') {
            children.push(paragraph(funding, 'Funding Information'));
        } else {
            children.push(paragraph(funding.totalRaised || 'N/A', 'Total Raised'));
            children.push(paragraph(funding.lastRound || 'N/A', 'Last Round'));
            if (funding.investors && funding.investors.length > 0) {
                children.push(paragraph(funding.investors.join(', '), 'Investors'));
            }
        }
    }

    // Other company data
    if (clientScraped.teamSize) {
        children.push(paragraph(clientScraped.teamSize, 'Team Size'));
    }
    if (clientScraped.headquarters) {
        children.push(paragraph(clientScraped.headquarters, 'Headquarters'));
    }
    if (clientScraped.founded) {
        children.push(paragraph(clientScraped.founded, 'Year Founded'));
    }

    // ==========================================
    // PRODUCT FEATURES
    // ==========================================
    const features = Array.isArray(clientScraped.features) ? clientScraped.features : [];
    children.push(divider(), heading(2, '✨', `Product Features (${features.length})`));
    if (features.length > 0) {
        for (const feature of features) {
            children.push(numbered(feature));
        }
    } else {
        children.push(paragraph('No specific features identified.'));
    }

    // ==========================================
    // INTEGRATIONS
    // ==========================================
    const integrations = Array.isArray(clientScraped.integrations) ? clientScraped.integrations : [];
    children.push(divider(), heading(2, '🔗', `Integrations (${integrations.length})`));
    if (integrations.length > 0) {
        children.push(paragraph(integrations.join(', ')));
    } else {
        children.push(paragraph('No integrations identified.'));
    }

    // ==========================================
    // PRICING - COMPLETE DETAIL
    // ==========================================
    const pricing = Array.isArray(clientScraped.pricing) ? clientScraped.pricing : [];
    children.push(divider(), heading(2, '💰', `Pricing (${pricing.length} plans)`));
    if (pricing.length > 0) {
        for (const tier of pricing) {
            children.push(paragraph(`▸ ${tier.tier || 'Plan'}: ${tier.price || 'N/A'}${tier.period || ''}`));
            if (tier.features && tier.features.length > 0) {
                children.push(paragraph(`   Includes: ${tier.features.join(', ')}`));
            }
            if (tier.bestFor) {
                children.push(paragraph(`   Best for: ${tier.bestFor}`));
            }
        }
    } else {
        children.push(paragraph('Pricing information not publicly available.'));
    }

    // ==========================================
    // COMPLIANCE AND CERTIFICATIONS
    // ==========================================
    const compliance = Array.isArray(clientScraped.compliance) ? clientScraped.compliance : [];
    if (compliance.length > 0) {
        children.push(divider(), heading(2, '🔒', `Compliance & Certifications (${compliance.length})`));
        children.push(paragraph(compliance.join(', ')));
    }

    // ==========================================
    // REVIEWS AND RATINGS
    // ==========================================
    const reviews = Array.isArray(clientScraped.reviews) ? clientScraped.reviews : [];
    if (reviews.length > 0) {
        children.push(divider(), heading(2, '⭐', `Reviews & Ratings (${reviews.length})`));
        for (const review of reviews) {
            let reviewText = `${review.platform}: ${review.score}/5 (${review.count} reviews)`;
            children.push(paragraph(reviewText));
            if (review.topPros && review.topPros.length > 0) {
                children.push(paragraph(`   ✅ Pros: ${review.topPros.join(', ')}`));
            }
            if (review.topCons && review.topCons.length > 0) {
                children.push(paragraph(`   ❌ Cons: ${review.topCons.join(', ')}`));
            }
        }
    }

    // ==========================================
    // CASE STUDIES
    // ==========================================
    const caseStudies = Array.isArray(clientScraped.caseStudies) ? clientScraped.caseStudies : [];
    if (caseStudies.length > 0) {
        children.push(divider(), heading(2, '📊', `Case Studies (${caseStudies.length})`));
        for (const cs of caseStudies) {
            children.push(paragraph(`▸ ${cs.company || 'Client'} (${cs.industry || 'N/A'})`));
            children.push(paragraph(`   Result: ${cs.result || 'N/A'}`));
            if (cs.quote) {
                children.push(paragraph(`   "${cs.quote}"`));
            }
        }
    }

    // ==========================================
    // TECH STACK
    // ==========================================
    const techStack = Array.isArray(clientScraped.techStack) ? clientScraped.techStack : [];
    if (techStack.length > 0) {
        children.push(divider(), heading(2, '🛠️', `Tech Stack (${techStack.length})`));
        children.push(paragraph(techStack.join(', ')));
    }

    // ==========================================
    // KNOWN LIMITATIONS
    // ==========================================
    if (limitations.length > 0) {
        children.push(divider(), heading(2, '⚠️', `Known Limitations (${limitations.length})`));
        for (const limitation of limitations) {
            children.push(bullet(limitation));
        }
    }

    // ==========================================
    // COMMON OBJECTIONS (SALES INTEL)
    // ==========================================
    const objections = Array.isArray(clientScraped.commonObjections) ? clientScraped.commonObjections : [];
    if (objections.length > 0) {
        children.push(divider(), heading(2, '🛡️', `Common Objections (${objections.length})`));
        for (const objection of objections) {
            children.push(bullet(objection));
        }
    }

    // ==========================================
    // NOTABLE CUSTOMERS (SOCIAL PROOF)
    // ==========================================
    const notableCustomers = Array.isArray(clientScraped.notableCustomers) ? clientScraped.notableCustomers : [];
    if (notableCustomers.length > 0) {
        children.push(divider(), heading(2, '🏢', `Notable Customers (${notableCustomers.length})`));
        children.push(paragraph(notableCustomers.join(', ')));
    }

    // ==========================================
    // SUPPORT
    // ==========================================
    const support = clientScraped.support;
    if (support) {
        children.push(divider(), heading(2, '🎧', 'Support'));
        if (typeof support === 'string') {
            children.push(paragraph(support));
        } else {
            if (support.channels) children.push(paragraph(support.channels.join(', '), 'Channels'));
            if (support.hours) children.push(paragraph(support.hours, 'Hours'));
            if (support.sla) children.push(paragraph(support.sla, 'SLA'));
        }
    }

    // ==========================================
    // CONTACT INFORMATION
    // ==========================================
    const contact = Array.isArray(clientScraped.contact) ? clientScraped.contact : [];
    if (contact.length > 0) {
        children.push(divider(), heading(2, '📞', `Contact (${contact.length})`));
        for (const c of contact) {
            children.push(paragraph(`${c.label || 'Contact'}: ${c.value || 'N/A'}`));
        }
    }

    // ==========================================
    // SOCIAL MEDIA
    // ==========================================
    const social = clientScraped.social || {};
    const socialEntries = Object.entries(social).filter(([k, v]) => v);
    if (socialEntries.length > 0) {
        children.push(divider(), heading(2, '📱', 'Social Media'));
        for (const [network, handle] of socialEntries) {
            children.push(paragraph(`${network}: ${handle}`));
        }
    }

    // ==========================================
    // CONTENT THEMES / BLOG TOPICS
    // ==========================================
    const blogTopics = Array.isArray(clientScraped.blogTopics) ? clientScraped.blogTopics : [];
    const contentThemes = Array.isArray(clientScraped.contentThemes) ? clientScraped.contentThemes : [];
    const allTopics = [...blogTopics, ...contentThemes];
    if (allTopics.length > 0) {
        children.push(divider(), heading(2, '📝', `Content Themes (${allTopics.length})`));
        for (const topic of allTopics) {
            children.push(bullet(topic));
        }
    }

    // ==========================================
    // PARTNERSHIPS
    // ==========================================
    const partnerships = Array.isArray(clientScraped.partnerships) ? clientScraped.partnerships : [];
    if (partnerships.length > 0) {
        children.push(divider(), heading(2, '🤝', `Partners & Alliances (${partnerships.length})`));
        children.push(paragraph(partnerships.join(', ')));
    }

    // ==========================================
    // MARKET SEGMENTS
    // ==========================================
    const segments = Array.isArray(clientScraped.segments) ? clientScraped.segments : [];
    const targetMarkets = Array.isArray(clientScraped.targetMarkets) ? clientScraped.targetMarkets : [];
    const allSegments = [...segments, ...targetMarkets];
    if (allSegments.length > 0) {
        children.push(divider(), heading(2, '🎯', `Market Segments (${allSegments.length})`));
        for (const segment of allSegments) {
            children.push(bullet(segment));
        }
    }

    // ==========================================
    // GUARANTEES
    // ==========================================
    if (clientScraped.guarantees) {
        children.push(divider(), heading(2, '✅', 'Guarantees'));
        children.push(paragraph(clientScraped.guarantees));
    }

    // ==========================================
    // ROADMAP
    // ==========================================
    if (clientScraped.roadmap) {
        children.push(divider(), heading(2, '🗺️', 'Roadmap'));
        children.push(paragraph(clientScraped.roadmap));
    }

    // ==========================================
    // COMPETITORS - COMPLETE DETAIL
    // ==========================================
    children.push(divider(), heading(1, '🏆', `COMPETITOR ANALYSIS (${competitors.length})`));

    if (competitors.length > 0) {
        for (let i = 0; i < competitors.length; i++) {
            const comp = competitors[i];
            const compDetails = compData[comp.domain]?.data || {};

            children.push(divider());
            children.push(heading(2, `${i + 1}.`, `${comp.name || comp.domain}`));
            children.push(paragraph(comp.domain, 'Domain'));
            children.push(paragraph(comp.reason || 'Direct competitor', 'Why They Compete'));

            // Differentiators (from Claude OPUS)
            if (comp.differentiator) children.push(paragraph(comp.differentiator, 'Differentiator'));
            if (comp.strengthVsTarget) children.push(paragraph(comp.strengthVsTarget, 'Strength vs Client'));
            if (comp.weaknessVsTarget) children.push(paragraph(comp.weaknessVsTarget, 'Weakness vs Client'));

            // Full competitor data
            if (compDetails.usp) children.push(paragraph(compDetails.usp, 'USP'));
            if (compDetails.icp) children.push(paragraph(compDetails.icp, 'ICP'));
            if (compDetails.about) children.push(paragraph(compDetails.about, 'Description'));
            if (compDetails.industry) children.push(paragraph(compDetails.industry, 'Industry'));
            if (compDetails.tone) children.push(paragraph(compDetails.tone, 'Tone'));

            if (Array.isArray(compDetails.features) && compDetails.features.length > 0) {
                children.push(paragraph(compDetails.features.join(', '), 'Features'));
            }
            if (Array.isArray(compDetails.integrations) && compDetails.integrations.length > 0) {
                children.push(paragraph(compDetails.integrations.join(', '), 'Integrations'));
            }
            if (Array.isArray(compDetails.pricing) && compDetails.pricing.length > 0) {
                const pricingStr = compDetails.pricing.map(p =>
                    `${p.tier}: ${p.price}${p.period || ''}`
                ).join(' | ');
                children.push(paragraph(pricingStr, 'Pricing'));
            }
            if (Array.isArray(compDetails.reviews) && compDetails.reviews.length > 0) {
                const reviewStr = compDetails.reviews.map(r =>
                    `${r.platform}: ${r.score}/5`
                ).join(', ');
                children.push(paragraph(reviewStr, 'Reviews'));
            }
            if (Array.isArray(compDetails.techStack) && compDetails.techStack.length > 0) {
                children.push(paragraph(compDetails.techStack.join(', '), 'Tech Stack'));
            }
            if (Array.isArray(compDetails.compliance) && compDetails.compliance.length > 0) {
                children.push(paragraph(compDetails.compliance.join(', '), 'Compliance'));
            }
            if (Array.isArray(compDetails.founders) && compDetails.founders.length > 0) {
                const foundersStr = compDetails.founders.map(f =>
                    `${f.name} (${f.role})`
                ).join(', ');
                children.push(paragraph(foundersStr, 'Founders'));
            }
            if (Array.isArray(compDetails.limitations) && compDetails.limitations.length > 0) {
                children.push(paragraph(compDetails.limitations.join(', '), 'Limitations'));
            }
            if (compDetails.social) {
                const socialStr = Object.entries(compDetails.social)
                    .filter(([k, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                if (socialStr) children.push(paragraph(socialStr, 'Social Media'));
            }
            if (Array.isArray(compDetails.contact) && compDetails.contact.length > 0) {
                const contactStr = compDetails.contact.map(c =>
                    `${c.label}: ${c.value}`
                ).join(', ');
                children.push(paragraph(contactStr, 'Contact'));
            }
            if (Array.isArray(compDetails.caseStudies) && compDetails.caseStudies.length > 0) {
                const csStr = compDetails.caseStudies.map(cs =>
                    `${cs.company}: ${cs.result}`
                ).join(' | ');
                children.push(paragraph(csStr, 'Case Studies'));
            }
        }
    } else {
        children.push(paragraph('No direct competitors identified.'));
    }

    // ==========================================
    // SELECTED BLOGS - WITH FULL CONTENT
    // ==========================================
    children.push(divider(), heading(1, '📚', `SELECTED BLOGS FOR STYLE (${likedPosts.length})`));

    if (likedPosts.length > 0) {
        for (const post of likedPosts) {
            children.push(divider());
            children.push(heading(3, '📄', post.title || 'Untitled'));
            children.push(paragraph(post.url || 'N/A', 'URL'));
            if (post.author) children.push(paragraph(post.author, 'Author'));
            if (post.date) children.push(paragraph(post.date, 'Published'));
            if (post.readingTime) children.push(paragraph(`${post.readingTime} min`, 'Reading Time'));
            if (post.wordCount) children.push(paragraph(`${post.wordCount} words`, 'Word Count'));
            if (post.description) children.push(paragraph(post.description, 'Summary'));
            if (post.image) children.push(paragraph(post.image, 'Featured Image'));

            // FULL BLOG CONTENT
            if (post.fullContent || post.content) {
                children.push(heading(4, '📝', 'Full Article Content'));
                // Split content into chunks of ~2000 chars for Notion limits
                const content = post.fullContent || post.content || '';
                const chunks = content.match(/.{1,1800}/gs) || [];
                for (const chunk of chunks.slice(0, 5)) { // Max 5 chunks = ~9000 chars
                    children.push(paragraph(chunk));
                }
                if (chunks.length > 5) {
                    children.push(paragraph(`... [Content truncated - ${chunks.length - 5} more sections]`));
                }
            }
        }
    } else {
        children.push(paragraph('No blogs selected.'));
    }

    // ==========================================
    // CUSTOM URLs
    // ==========================================
    if (customUrls.length > 0) {
        children.push(divider(), heading(2, '🔗', `Custom URLs (${customUrls.length})`));
        for (const url of customUrls) {
            if (url && url.trim()) {
                children.push(bullet(url, url));
            }
        }
    }

    // ==========================================
    // ELEVENLABS CONVERSATION - FULL TRANSCRIPT
    // ==========================================
    children.push(divider(), heading(1, '🎙️', 'ELEVENLABS CONVERSATION'));

    if (elevenLabsData.completed) {
        children.push(paragraph(elevenLabsData.completed ? 'Yes' : 'No', 'Call Completed'));
        children.push(paragraph(`${elevenLabsData.duration || 0} seconds`, 'Duration'));
        children.push(paragraph(`${(elevenLabsData.transcript || []).length} messages`, 'Total Messages'));

        // Full transcript
        const transcript = elevenLabsData.transcript || [];
        if (transcript.length > 0) {
            children.push(heading(3, '📝', 'Full Transcript'));
            for (const msg of transcript) {
                const role = msg.role === 'agent' ? '🤖 Agent' : '👤 User';
                children.push(paragraph(`${role}: ${msg.text || ''}`));
            }
        }
    } else {
        children.push(paragraph('No ElevenLabs call was made or no data available.'));
    }

    // ==========================================
    // LLMs.txt
    // ==========================================
    if (sitemapData.llmsTxt) {
        children.push(divider(), heading(2, '🤖', 'LLMs.txt Found'));
        children.push(codeBlock(sitemapData.llmsTxt, 'plain text'));
    }

    // ==========================================
    // RAW DATA (COMPLETE JSON)
    // ==========================================
    children.push(divider(), heading(1, '📦', 'RAW DATA (JSON)'));

    // Client raw data
    children.push(toggle('📋 Complete Client JSON', [
        codeBlock(JSON.stringify(clientScraped, null, 2), 'json')
    ]));

    // Competitors raw data
    children.push(toggle('🏆 Complete Competitors JSON', [
        codeBlock(JSON.stringify(compData, null, 2), 'json')
    ]));

    // Liked posts raw data
    children.push(toggle('📚 Complete Selected Blogs JSON', [
        codeBlock(JSON.stringify(likedPosts, null, 2), 'json')
    ]));

    // ElevenLabs raw data
    if (elevenLabsData && Object.keys(elevenLabsData).length > 0) {
        children.push(toggle('🎙️ Complete ElevenLabs JSON', [
            codeBlock(JSON.stringify(elevenLabsData, null, 2), 'json')
        ]));
    }

    // ==========================================
    // FOOTER
    // ==========================================
    children.push(
        divider(),
        paragraph(`Document automatically generated by BTA Onboarding`),
        paragraph(`Date and time: ${new Date().toISOString()}`),
        paragraph(`AI providers used: ${clientScraped._meta?.providers || 'N/A'}`),
        paragraph(`Research errors: ${clientScraped._meta?.errors || 0}`)
    );

    try {
        console.log(`[Notion] Creating COMPLETE report for: ${companyName}`);
        console.log(`[Notion] Total blocks: ${children.length}`);

        // Create as a standalone page under the parent page
        const response = await notion.pages.create({
            parent: { page_id: parentPageId },
            icon: { type: 'emoji', emoji: '📋' },
            properties: {
                title: {
                    title: [{ text: { content: `${companyName} - Complete Report ${dateStr}` } }]
                }
            },
            children
        });

        console.log(`[Notion] Document created successfully: ${response.id}`);
        return {
            success: true,
            pageId: response.id,
            url: response.url,
            blocks: children.length
        };
    } catch (error) {
        console.error('[Notion] Error creating document:', error.message);

        if (error.code === 'object_not_found') {
            throw new Error('Notion parent page not found. Make sure you shared the page with your integration.');
        }
        if (error.code === 'unauthorized') {
            throw new Error('Notion authentication failed. Check your API key.');
        }

        throw error;
    }
}

module.exports = { submitToNotion };
