const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { scrapeStructuralData } = require("./structuralScraper");

// ============================================
// UNIVERSAL RESEARCH PROMPT (DRY)
// One function for client AND competitor research
// ============================================

function buildJsonSchema(domain, mode, promptMode = 'master') {
    if (promptMode === 'fastest' && mode === 'client') {
        return `{
  "name": "Official Company Name",
  "domain": "${domain}",
  "about": "1-2 sentence summary",
  "niche": "Specific niche",
  "usp": "Unique selling proposition",
  "features": ["Key product features"],
  "pricing": [{"tier": "Name", "price": "$", "period": "/month"}],
  "competitors": [{"domain": "competitor.com", "name": "Name", "reason": "Same product + same buyer"}],
  "confidence": "high | medium | low"
}`;
    }

    if (promptMode === 'lite') {
        if (mode === 'client') {
            return `{
  "name": "Official Company Name",
  "domain": "${domain}",
  "about": "Company summary or null",
  "niche": "Specific niche: [approach] + [product] + [buyer]",
  "usp": "Unique selling proposition or null",
  "icp": "Ideal customer profile or null",
  "features": ["Specific product features"],
  "pricing": [{"tier": "Name", "price": "$", "period": "/month"}],
  "integrations": ["Known integrations"],
  "limitations": ["Verified limitations"],
  "reviews": [{"platform": "G2|Capterra|Trustpilot", "score": "4.8", "count": "150", "summary": "Theme"}],
  "competitors": [{"domain": "competitor.com", "name": "Name", "reason": "Same product + same buyer", "differentiator": "How they differ"}],
  "confidence": "high | medium | low",
  "confidenceNotes": "What was verified vs missing"
}`;
        }
        return `{
  "name": "Official Company Name",
  "domain": "${domain}",
  "about": "Company summary or null",
  "niche": "Specific niche",
  "usp": "Unique selling proposition or null",
  "features": ["Specific product features"],
  "pricing": [{"tier": "Name", "price": "$", "period": "/month"}],
  "integrations": ["Known integrations"],
  "limitations": ["Verified limitations"],
  "strengthVsTarget": "Where stronger vs target",
  "weaknessVsTarget": "Where weaker vs target",
  "pricingComparison": "Cheaper | Similar | More expensive | Unknown",
  "marketPositionVsTarget": "Brief positioning comparison",
  "confidence": "high | medium | low",
  "confidenceNotes": "What was verified vs missing"
}`;
    }

    const base = `{
  "name": "Official Company Name",
  "domain": "${domain}",
  "usp": "Unique selling proposition — what makes them different, or null",
  "icp": "Ideal Customer Profile — specific buyer persona, company size, industry in one paragraph, or null",
  "tone": "Brand voice description (e.g., 'Professional but approachable, targets non-technical SMB owners') or null",
  "about": "Company description in 3-4 sentences covering what they do, for whom, and how, or null",
  "industry": "Primary industry vertical or null",
  "niche": "Ultra-specific product niche: [technology/approach] + [product type] + [target buyer]",
  "productModel": "SaaS | API | Marketplace | Hardware | Other or null",
  "yearFounded": "YYYY or null",
  "headquarters": "City, State/Country or null",
  "teamSize": "e.g., '11-50', '51-200' or null",
  "funding": "e.g., '$15M Series A' or 'Bootstrapped' or null",
  "features": ["Specific verified product features — be detailed, not generic"],
  "integrations": ["Verified integrations with other tools/platforms"],
  "techStack": ["Known/detected technologies (e.g., 'React', 'AWS', 'Stripe')"],
  "pricing": [
    {
      "tier": "Plan name",
      "price": "Dollar amount or 'Custom' or 'Free'",
      "period": "/month or /year or /user/month",
      "features": ["Key features included in this tier"]
    }
  ],
  "founders": [
    {
      "name": "Full name",
      "role": "Title",
      "background": "Brief relevant background (prior companies, expertise)",
      "linkedin": "URL or null"
    }
  ],
  "compliance": ["SOC 2", "GDPR", "HIPAA", "CCPA", "ISO 27001"],
  "reviews": [
    {
      "platform": "G2 | Capterra | Trustpilot | ProductHunt",
      "score": "4.8",
      "count": "150",
      "summary": "One-sentence summary of recurring review themes or null"
    }
  ],
  "caseStudies": [
    {
      "company": "Customer company name",
      "result": "Specific quantified outcome (e.g., '40% reduction in call abandonment')",
      "industry": "Customer's industry"
    }
  ],
  "notableCustomers": ["Named customer logos found publicly"],
  "social": {
    "twitter": "handle or null",
    "linkedin": "URL or null",
    "github": "handle or null",
    "youtube": "URL or null"
  },
  "support": "Support channels and hours as text (e.g., 'Live chat, email, phone — 24/7') or null",
  "contact": [
    {"label": "Sales Email", "value": "sales@domain.com", "type": "email"},
    {"label": "Phone", "value": "+1-xxx-xxx-xxxx", "type": "phone"},
    {"label": "Demo", "value": "https://domain.com/demo", "type": "url"}
  ],
  "limitations": ["Verified limitations or common complaints from real user feedback"],
  "commonObjections": ["Sales objections a real buyer might raise"],
  "blogTopics": ["5-10 recent blog themes that reveal their content/SEO strategy"],
  "segments": ["Customer segments they serve"],
  "contentThemes": ["Marketing/content themes"],
  "partnerships": ["Known technology or business partnerships"],`;

    if (mode === 'client') {
        return base + `
  "competitors": [
    {
      "domain": "competitor.com",
      "name": "Competitor Name",
      "reason": "Both sell [specific product] to [specific buyer persona]",
      "differentiator": "How they differ (pricing, features, positioning)"
    }
  ],
  "confidence": "high | medium | low",
  "confidenceNotes": "Explain what you could and couldn't verify"
}`;
    } else {
        return base + `
  "strengthVsTarget": "Where this company is STRONGER than the target company (be specific)",
  "weaknessVsTarget": "Where this company is WEAKER than the target company (be specific)",
  "pricingComparison": "Cheaper | Similar | More expensive | Unknown",
  "marketPositionVsTarget": "Brief positioning comparison",
  "confidence": "high | medium | low",
  "confidenceNotes": "Explain what you could and couldn't verify"
}`;
    }
}

/**
 * Specialized prompt for competitor discovery only
 * @param {string} domain - The client domain
 * @param {string} niche - The specific niche/industry
 * @param {object|null} structuralContext - Pre-scraped data
 */
function buildCompetitorDiscoveryPrompt(domain, niche, structuralContext) {
    const context = structuralContext?.keywords ? `Keywords: ${structuralContext.keywords.slice(0, 10).join(', ')}` : '';

    return `You are a competitive intelligence analyst. Find 5-8 direct competitors of ${domain}.

${niche ? `NICHE: ${niche}` : ''}
${context}

Run these 3 searches:
1. "${domain} competitors alternatives"
2. "${domain} vs"
3. "best ${niche || 'software'} tools"

VALIDATION RULES:
✓ INCLUDE only if: same product type + same buyer persona
✗ EXCLUDE: Salesforce, HubSpot, broad platforms, parent categories

Return ONLY valid JSON:
{
  "competitors": [
    {"domain": "competitor.com", "name": "Name", "reason": "Brief reason"}
  ]
}`;
}

/**
 * Universal research prompt builder — DRY for client AND competitor
 * @param {string} domain - The domain to research
 * @param {'client'|'competitor'} mode
 * @param {object|null} structuralContext - Pre-scraped data from structuralScraper
 * @param {object|null} clientContext - For competitor mode: {name, domain, niche, usp}
 */
function buildResearchPrompt(domain, mode, structuralContext, clientContext, promptMode = 'lite') {
    // 3 STRATEGIC QUERIES - minimal but comprehensive
    const isClient = mode === 'client';
    const isLite = promptMode === 'lite';
    
    let prompt = `You are a senior competitive intelligence analyst researching ${domain}.

${isLite ? 'You are in LITE mode: prioritize speed and accuracy. Use concise extraction.' : 'You are in MASTER mode: prioritize depth and coverage.'}

Run these strategic web searches and extract data:

QUERY 1: "${domain}" "${domain} features" "${domain} pricing"
→ Company basics: name, what they do, product model, key features (with details), pricing tiers, target buyer

QUERY 2: "${domain} competitors" "${domain} alternatives" "${domain} vs"
→ Direct competitors only (same product type, same buyer). Return AT LEAST 5 when possible. If fewer than 5 truly qualify, return all valid ones.
→ For each: domain, name, why they compete
${!isClient && clientContext ? `→ Also search "${domain} vs ${clientContext.domain}" for comparison` : ''}

QUERY 3: "${domain} reviews" "${domain} G2" "${domain} problems"
→ Review sentiment (positive/negative), key limitations/complaints, common objections

`;

    // Add any pre-scraped context for efficiency
    if (structuralContext && (structuralContext.headline || structuralContext.features?.length)) {
        prompt += `ALREADY KNOWN (validate and enrich):
`;
        if (structuralContext.headline) prompt += `- ${structuralContext.headline}\n`;
        if (structuralContext.features?.length) prompt += `- Features: ${structuralContext.features.slice(0, 5).join(', ')}\n`;
        prompt += `\n`;
    }

    if (!isClient && clientContext) {
        prompt += `COMPARISON CONTEXT:
Target: ${clientContext.name} (${clientContext.domain})
Niche: ${clientContext.niche || 'Not specified'}
USP: ${clientContext.usp || 'Not specified'}

`;
    }

    prompt += `COMPETITOR VALIDATION (strict):
✓ INCLUDE: Same product type + same buyer persona + same market level
✗ EXCLUDE: Broad platforms (Salesforce, HubSpot), parent categories, guessed competitors

Return ONLY valid JSON:

${buildJsonSchema(domain, mode, promptMode)}`;

    return prompt;
}

function shouldEscalateToMaster(result) {
    if (!result) return true;
    const lowConfidence = String(result.confidence || '').toLowerCase() === 'low';
    const missingCore = !result.about || !result.niche || !Array.isArray(result.features) || result.features.length < 3;
    return lowConfidence || missingCore;
}

function getProviderFunctionMap() {
    return {
        perplexity: callPerplexity,
        openai: callOpenAI,
        gemini: callGemini
    };
}

function getProviderOrder() {
    const providerMap = getProviderFunctionMap();
    const configuredPrimary = String(process.env.AI_PROVIDER_PRIMARY || 'openai').toLowerCase();
    const primary = providerMap[configuredPrimary] ? configuredPrimary : 'openai';
    const preferredFallbackOrder = ['openai', 'perplexity', 'gemini'];
    const fallbacks = preferredFallbackOrder.filter(p => p !== primary && providerMap[p]);
    return [primary, ...fallbacks];
}

function isGeminiQuotaError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return (
        message.includes("quota") ||
        message.includes("rate limit") ||
        message.includes("free_tier") ||
        message.includes("generativelanguage.googleapis.com/generate_content_free_tier_requests") ||
        message.includes("generaterequestspedayperprojectpermodel-freetier") ||
        message.includes("generaterequestsperdayperprojectpermodel-freetier")
    );
}

async function callPrimaryThenFallback(prompt, context = "research", options = {}) {
    const fallbackEnabled = String(process.env.AI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
    const fastFailOnGeminiQuota = String(process.env.AI_FAST_FAIL_ON_GEMINI_QUOTA || 'true').toLowerCase() !== 'false';
    const providerMap = getProviderFunctionMap();
    const providerOrder = getProviderOrder();
    const providerOptions = options || {};

    const primaryProvider = providerOrder[0];
    const primaryFn = providerMap[primaryProvider];

    try {
        console.log(`[AI] [${context}] Trying primary provider: ${primaryProvider}`);
        const primaryResult = await primaryFn(prompt, providerOptions);
        console.log(`[AI] [${context}] Primary provider succeeded: ${primaryProvider}`);
        return primaryResult;
    } catch (e) {
        console.error(`[AI] [${context}] Primary provider failed (${primaryProvider}): ${e.message}`);
        if (primaryProvider === 'gemini' && fastFailOnGeminiQuota && isGeminiQuotaError(e)) {
            throw new Error("Gemini quota exceeded. Fast-fail enabled, skipping OpenAI fallback to avoid slow response.");
        }
        if (!fallbackEnabled) throw e;
    }

    for (let index = 1; index < providerOrder.length; index++) {
        const providerName = providerOrder[index];
        const providerFn = providerMap[providerName];
        try {
            console.log(`[AI] [${context}] Trying fallback provider: ${providerName}`);
            const fallbackResult = await providerFn(prompt, providerOptions);
            console.log(`[AI] [${context}] Fallback provider succeeded: ${providerName}`);
            return fallbackResult;
        } catch (e) {
            console.error(`[AI] [${context}] Fallback provider failed (${providerName}): ${e.message}`);
        }
    }

    throw new Error("All configured AI providers failed");
}

// ============================================
// NORMALIZE AI OUTPUT FOR FRONTEND
// ============================================

function normalizeResearchOutput(raw) {
    if (!raw) return null;

    const result = { ...raw };

    // icp: if object, flatten to string
    if (result.icp && typeof result.icp === 'object') {
        const parts = [];
        if (result.icp.buyerPersona) parts.push(result.icp.buyerPersona);
        if (result.icp.companySize) parts.push(result.icp.companySize);
        if (result.icp.industries?.length) parts.push(result.icp.industries.join(', '));
        if (result.icp.triggerEvents?.length) parts.push(`Triggers: ${result.icp.triggerEvents.join(', ')}`);
        result.icp = parts.join(' — ') || null;
    }

    // features: flatten if grouped [{category, items}] → flat string array
    if (Array.isArray(result.features) && result.features.length > 0 && typeof result.features[0] === 'object') {
        result.features = result.features.flatMap(f => f.items || [f.name || f.category || String(f)]);
    }
    result.features = Array.isArray(result.features) ? result.features.filter(Boolean) : [];

    // pricing: normalize to array of {tier, price, period}
    if (result.pricing && !Array.isArray(result.pricing)) {
        // Handle {model, freeTrial, tiers, contractNotes} format
        if (result.pricing.tiers && Array.isArray(result.pricing.tiers)) {
            result.pricing = result.pricing.tiers;
        } else {
            result.pricing = [];
        }
    }
    result.pricing = Array.isArray(result.pricing) ? result.pricing : [];

    // funding: if object, flatten to string
    if (result.funding && typeof result.funding === 'object') {
        const parts = [];
        if (result.funding.totalRaised) parts.push(result.funding.totalRaised);
        if (result.funding.stage) parts.push(result.funding.stage);
        if (result.funding.lastRound) parts.push(result.funding.lastRound);
        result.funding = parts.join(' — ') || null;
    }

    // teamSize: normalize from employeeRange or team_size
    result.teamSize = result.teamSize || result.employeeRange || result.team_size || null;
    delete result.employeeRange;
    delete result.team_size;

    // support: if object, flatten to string
    if (result.support && typeof result.support === 'object') {
        const parts = [];
        if (result.support.channels?.length) parts.push(result.support.channels.join(', '));
        if (result.support.hours) parts.push(result.support.hours);
        if (result.support.notes) parts.push(result.support.notes);
        result.support = parts.join(' — ') || null;
    }

    // Ensure arrays exist
    const arrayFields = ['integrations', 'compliance', 'techStack', 'limitations',
        'commonObjections', 'blogTopics', 'segments', 'contentThemes',
        'partnerships', 'notableCustomers', 'competitors'];
    for (const field of arrayFields) {
        if (!Array.isArray(result[field])) result[field] = [];
    }

    // Ensure complex arrays exist
    const complexArrayFields = ['founders', 'reviews', 'caseStudies', 'contact'];
    for (const field of complexArrayFields) {
        if (!Array.isArray(result[field])) result[field] = [];
    }

    // Ensure social object
    result.social = result.social || {};

    // Ensure string fields
    const stringFields = ['name', 'domain', 'usp', 'icp', 'tone', 'about', 'industry',
        'niche', 'productModel', 'yearFounded', 'headquarters', 'teamSize',
        'funding', 'support', 'confidence', 'confidenceNotes',
        'strengthVsTarget', 'weaknessVsTarget', 'pricingComparison', 'marketPositionVsTarget'];
    for (const field of stringFields) {
        if (result[field] === undefined) result[field] = null;
    }

    return result;
}

// ============================================
// JSON PARSER
// ============================================

function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
        console.error("[AI] Failed to parse JSON. First 500 chars:", text.substring(0, 500));
        throw new Error("No JSON found in response");
    }
    try {
        const parsed = JSON.parse(match[0]);
        console.log("[AI] Successfully parsed JSON with keys:", Object.keys(parsed).join(', '));
        return parsed;
    } catch (e) {
        console.error("[AI] JSON parse error:", e.message);
        console.error("[AI] Attempted to parse:", match[0].substring(0, 500));
        throw e;
    }
}

function normalizeDomainKey(input) {
    if (!input || typeof input !== 'string') return null;
    try {
        const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
        const parsed = new URL(withProtocol);
        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        if (!host.includes('.')) return null;
        return host;
    } catch {
        const cleaned = String(input)
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .split('/')[0];
        return cleaned.includes('.') ? cleaned : null;
    }
}

function sanitizeCompetitor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const domain = normalizeDomainKey(raw.domain || raw.url || raw.website || raw.name);
    if (!domain) return null;

    const fallbackName = domain.replace(/\.(com|io|net|org|co|ai|app|dev|tech|xyz).*/, '');
    const name = String(raw.name || fallbackName || domain).trim();
    const reason = String(raw.reason || 'Competitor').trim();
    const differentiator = raw.differentiator ? String(raw.differentiator).trim() : null;

    return { domain, name, reason, differentiator };
}

function mergeAndDedupeCompetitors(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const sanitized = sanitizeCompetitor(item);
            if (!sanitized) continue;
            const key = sanitized.domain;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(sanitized);
        }
    }
    return merged;
}

// ============================================
// RESEARCH FUNCTIONS
// ============================================

/**
 * Research a client domain — provider primary + fallback
 * Returns { data, competitors }
 */
async function researchDomain(domain) {
    console.log(`[AI] ═══ Starting research for: ${domain} ═══`);
    const minCompetitors = 5;
    const researchMode = String(process.env.RESEARCH_SPEED_MODE || 'balanced').toLowerCase();
    const fastestMode = researchMode === 'fastest';
    const onboardTimeoutMs = Math.max(5000, Number(process.env.ONBOARD_AI_TIMEOUT_MS || (fastestMode ? 30000 : 60000)));
    const timings = {};

    // Phase 1: Free structural scrape
    let structuralData = null;
    try {
        const structuralStartedAt = Date.now();
        structuralData = await scrapeStructuralData(domain);
        timings.structuralMs = Date.now() - structuralStartedAt;
    } catch (e) {
        timings.structuralMs = timings.structuralMs || 0;
        console.log(`[AI] Structural scrape failed (non-fatal): ${e.message}`);
    }

    const promptMode = fastestMode
        ? 'fastest'
        : (process.env.RESEARCH_PROMPT_MODE || 'lite').toLowerCase();
    const prompt = buildResearchPrompt(domain, 'client', structuralData, null, promptMode);

    let result = null;
    let competitors = [];

    try {
        const primaryStartedAt = Date.now();
        result = await callPrimaryThenFallback(
            prompt,
            "research-domain-primary",
            { timeoutMs: onboardTimeoutMs }
        );
        timings.primaryProviderMs = Date.now() - primaryStartedAt;
        console.log(`[AI] Primary research succeeded! Company: "${result.name}" | Niche: "${result.niche}"`);
        if (Array.isArray(result.competitors) && result.competitors.length > 0) {
            competitors = mergeAndDedupeCompetitors(result.competitors);
            console.log(`[AI] Primary research found ${competitors.length} competitors`);
        }
    } catch (e) {
        timings.primaryProviderMs = timings.primaryProviderMs || 0;
        console.error(`[AI] All providers failed on primary pass: ${e.message}`);
    }

    // Optional master escalation when lite output is weak (disabled in fastest mode)
    if (!fastestMode && result && promptMode === 'lite' && shouldEscalateToMaster(result)) {
        try {
            console.log("[AI] Escalating to master prompt due to low confidence or missing core fields...");
            const masterPrompt = buildResearchPrompt(domain, 'client', structuralData, null, 'master');
            const masterStartedAt = Date.now();
            const masterResult = await callPrimaryThenFallback(
                masterPrompt,
                "research-domain-master",
                { timeoutMs: onboardTimeoutMs }
            );
            timings.masterProviderMs = Date.now() - masterStartedAt;
            if (masterResult) {
                result = masterResult;
                if (Array.isArray(masterResult.competitors) && masterResult.competitors.length > 0) {
                    competitors = mergeAndDedupeCompetitors(competitors, masterResult.competitors);
                }
            }
        } catch (e) {
            timings.masterProviderMs = timings.masterProviderMs || 0;
            console.error(`[AI] Master escalation failed (non-fatal): ${e.message}`);
        }
    }

    // Step 3: If too few competitors were found, run a provider-aware recovery pass
    if (result && competitors.length < minCompetitors) {
        console.log(`[AI] Only ${competitors.length} competitors found, trying recovery to reach ${minCompetitors}...`);
        try {
            const competitorPrompt = buildCompetitorDiscoveryPrompt(domain, result.niche || result.industry, structuralData);
            const recoveryStartedAt = Date.now();
            const discoveryResult = await callPrimaryThenFallback(
                competitorPrompt,
                "competitor-discovery-recovery",
                { timeoutMs: onboardTimeoutMs }
            );
            timings.recoveryProviderMs = Date.now() - recoveryStartedAt;
            if (discoveryResult && discoveryResult.competitors && discoveryResult.competitors.length > 0) {
                competitors = mergeAndDedupeCompetitors(competitors, discoveryResult.competitors);
                console.log(`[AI] Competitor recovery merged to ${competitors.length} competitors`);
            }
        } catch (e) {
            timings.recoveryProviderMs = timings.recoveryProviderMs || 0;
            console.log(`[AI] Competitor discovery recovery failed (non-fatal): ${e.message}`);
        }
    }

    if (!result) {
        console.error("[AI] All providers failed");
        return null;
    }

    // Merge competitors back into result
    result.competitors = competitors;

    const normalized = normalizeResearchOutput(result);

    // Extract competitors for separate return
    const formattedCompetitors = mergeAndDedupeCompetitors(normalized.competitors);

    console.log(`[AI] ═══ Research complete: ${normalized.features?.length || 0} features, ${formattedCompetitors.length} competitors ═══`);
    console.log(`[AI] [research-domain] stage timings: ${JSON.stringify(timings)}`);

    return {
        data: normalized,
        competitors: formattedCompetitors,
        timings
    };
}

/**
 * Research a single competitor — provider primary + fallback
 * Returns normalized competitor data with comparison fields
 */
async function researchCompetitor(domain, clientContext) {
    console.log(`[AI] Researching competitor: ${domain}`);

    // Free structural scrape
    let structuralData = null;
    try {
        structuralData = await scrapeStructuralData(domain);
    } catch (e) {
        console.log(`[AI] Structural scrape failed (non-fatal): ${e.message}`);
    }

    const promptMode = (process.env.RESEARCH_PROMPT_MODE || 'lite').toLowerCase();
    const prompt = buildResearchPrompt(domain, 'competitor', structuralData, clientContext, promptMode);

    let result = null;
    try {
        result = await callPrimaryThenFallback(prompt, "research-competitor-primary");
        console.log(`[AI] Competitor research succeeded: "${result.name}"`);
    } catch (e) {
        console.error(`[AI] Primary/fallback failed for competitor ${domain}: ${e.message}`);
    }

    if (result && promptMode === 'lite' && shouldEscalateToMaster(result)) {
        try {
            const masterPrompt = buildResearchPrompt(domain, 'competitor', structuralData, clientContext, 'master');
            const masterResult = await callPrimaryThenFallback(masterPrompt, "research-competitor-master");
            if (masterResult) {
                result = masterResult;
            }
        } catch (e) {
            console.error(`[AI] Competitor master escalation failed (non-fatal): ${e.message}`);
        }
    }

    if (!result) return null;

    const normalized = normalizeResearchOutput(result);
    console.log(`[AI] Competitor done: ${domain} | strength: ${normalized.strengthVsTarget ? 'YES' : 'NO'}`);
    return normalized;
}

// ============================================
// PROVIDER CALLS
// ============================================

async function callGemini(prompt, options = {}) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("No GOOGLE_API_KEY");
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || 60000));

    console.log("[AI] Calling Gemini 2.5 Flash with Google Search...");
    const ai = new GoogleGenAI({
        apiKey,
        requestOptions: {
            timeout: timeoutMs
        }
    });

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const responseText = response.text ||
        response.candidates?.[0]?.content?.parts?.[0]?.text ||
        response.response?.text?.();

    if (!responseText) throw new Error("No text in Gemini response");

    const metadata = response.candidates?.[0]?.groundingMetadata;
    if (metadata?.webSearchQueries) {
        console.log("[AI] Search queries:", metadata.webSearchQueries);
    }
    if (metadata?.groundingChunks?.length > 0) {
        console.log(`[AI] Grounded with ${metadata.groundingChunks.length} sources`);
    }

    return parseJson(responseText);
}

async function callPerplexity(prompt, options = {}) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("No PERPLEXITY_API_KEY");
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || 60000));

    console.log("[AI] Calling Perplexity Sonar Pro...");
    const client = new OpenAI({
        apiKey,
        baseURL: "https://api.perplexity.ai",
        timeout: timeoutMs
    });

    const completion = await client.chat.completions.create({
        model: "sonar-pro",
        messages: [
            {
                role: "system",
                content: "You are a research assistant. Search the web and provide detailed, accurate information. Return only valid JSON."
            },
            {
                role: "user",
                content: prompt
            }
        ],
        temperature: 0.2
    });

    const responseText = completion.choices?.[0]?.message?.content;
    if (!responseText) throw new Error("No text in Perplexity response");
    return parseJson(responseText);
}

async function callOpenAI(prompt, options = {}) {
    if (!process.env.OPENAI_API_KEY) throw new Error("No OPENAI_API_KEY");
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || 60000));

    console.log("[AI] Calling OpenAI GPT-4o with web search...");
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: timeoutMs
    });

    try {
        // Try responses API with web_search first
        const response = await openai.responses.create({
            model: "gpt-4o",
            tools: [{ type: "web_search" }],
            input: prompt,
        });

        return parseJson(response.output_text);
    } catch (error) {
        console.warn(`[AI] Responses API failed: ${error.message}, trying chat completions...`);

        // Fallback to standard chat completions (without web search)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "You are a research assistant. Search the web and provide detailed information."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 4000
        });

        return parseJson(completion.choices[0].message.content);
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    researchDomain,
    researchCompetitor,
    buildResearchPrompt,     // exported for testing
    normalizeResearchOutput, // exported for testing
    parseJson
};
