const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { scrapeStructuralData } = require("./structuralScraper");

// Keep runtime predictable near ship: fewer env toggles, stable defaults.
const ONBOARD_TIMEOUT_MS = 30000;
const DEFAULT_CLIENT_PROMPT_MODE = "lite";
const DEFAULT_COMPETITOR_PROMPT_MODE = "competitor_enriched";

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
    // Unified schema for both client and competitor.
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
  "activeHours": "Typical support/engagement hours in local timezone or null",
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
  "contentStrategy": "Brief description of content marketing approach or null",
  "segments": ["Customer segments they serve"],
  "contentThemes": ["Marketing/content themes"],
  "partnerships": ["Known technology or business partnerships"],
  "competitors": [
    {
      "domain": "competitor.com",
      "name": "Competitor Name",
      "reason": "Both sell [specific product] to [specific buyer persona]",
      "differentiator": "How they differ (pricing, features, positioning)"
    }
  ],
  "strengthVsTarget": "Where this company is STRONGER than the target company (be specific) or null",
  "weaknessVsTarget": "Where this company is WEAKER than the target company (be specific) or null",
  "pricingComparison": "Cheaper | Similar | More expensive | Unknown",
  "marketPositionVsTarget": "Brief positioning comparison or null",
  "confidence": "high | medium | low",
  "confidenceNotes": "Explain what you could and couldn't verify",
  "searchesPerformed": ["Actual search queries executed for auditability"],
  "researchDate": "YYYY-MM-DD"
}`;
    return base;
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
function buildResearchPrompt(domain, mode, structuralContext, clientContext, promptMode = 'lite', enrichmentContext = null) {
    const isClient = mode === 'client';
    const isCompetitorEnriched = mode === 'competitor' && promptMode === 'competitor_enriched';
    const isPostCallEnrichment = promptMode === 'postcall_enrichment';
    
    let prompt = `${isClient ? `You are a senior market research analyst. Your task is to produce a comprehensive intelligence report on https://${domain}.` : `You are a competitive intelligence analyst. Research https://${domain} exhaustively.`}

You MUST use web search extensively. Do NOT rely on model memory. Every claim should be verified with live sources or the company website.
If something cannot be verified, use null or [].
Never fabricate data.

${isPostCallEnrichment
            ? 'You are in POSTCALL_ENRICHMENT mode: prioritize filling missing fields using interview + blog context, without changing already-solid existing values.'
            : (isCompetitorEnriched
                ? 'You are in COMPETITOR_ENRICHED mode: maximize verified profile coverage in one pass.'
                : 'You are in CORE mode: prioritize accuracy and specificity.')}

PHASE 1 — COMPANY FOUNDATION
1) Search "${domain}", "${domain} about", "${domain} what is", "${domain} company overview"
2) Identify:
   - What they sell (product type, delivery model)
   - Who they sell to (buyer persona, company size, industry)
   - USP and positioning
   - Tone of voice and brand style

PHASE 2 — COMMERCIAL DETAILS
3) Search "${domain} pricing", "${domain} plans", "how much does ${domain} cost"
4) Search "${domain} integrations", "${domain} API", "${domain} tech stack"
5) Search "${domain} features", "${domain} product tour", "${domain} changelog"

PHASE 3 — CREDIBILITY & SOCIAL PROOF
6) Search "${domain} reviews G2", "${domain} reviews Capterra", "${domain} Trustpilot"
7) Search "${domain} case study", "${domain} customer stories", "${domain} testimonials"
8) Search "${domain} SOC 2", "${domain} GDPR", "${domain} HIPAA", "${domain} security"

PHASE 4 — PEOPLE & BACKSTORY
9) Search "${domain} founders", "${domain} leadership team", "${domain} Crunchbase"
10) Search "${domain} funding", "${domain} Series", "${domain} investors"
11) Search "${domain} blog", "${domain} content"

PHASE 5 — CONTACT & SOCIAL PRESENCE
12) Search "${domain} Twitter", "${domain} LinkedIn", "${domain} GitHub"
13) Search "${domain} support", "${domain} contact", "${domain} help center"

PHASE 6 — COMPETITOR IDENTIFICATION (STRICT)
Step A: Define SPECIFIC niche in 5-15 words: [technology/approach] + [product type] + [target buyer]
Step B: Run:
  - "${domain} competitors"
  - "${domain} alternatives"
  - "${domain} vs"
  - "best [niche keywords] software"
Step C: Include only if all:
  - Same product type
  - Same buyer persona/vertical
  - Same market level (SMB vs enterprise)
  - Real shortlist overlap
Exclude broad platforms and guesses.
${!isClient && clientContext ? `Also search "${domain} vs ${clientContext.domain}" + competitor pricing/reviews for stronger comparison fields.` : ''}

PHASE 7 — LIMITATIONS & GAPS
14) Search "${domain} complaints", "${domain} problems", "${domain} limitations", "${domain} reddit"
15) Search "${domain} missing features", "${domain} feature request"

${isCompetitorEnriched ? `DIRECTORY PASS:
Collect verifiable URLs for social/content/developer/review/business/app profiles.` : ''}
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

    if (isPostCallEnrichment && enrichmentContext) {
        prompt += `POST-CALL ENRICHMENT CONTEXT:
${enrichmentContext}

POST-CALL RULES:
- Fill missing/empty fields using interview and blog context when verifiable.
- Prioritize filling: tone, activeHours, support/contact details, reviews/limitations confidence notes.
- Keep already-strong existing fields consistent; do not degrade specificity.
- If interview claims are not web-verifiable, mark lower confidence and mention in confidenceNotes.

`;
    }

    prompt += `OUTPUT RULES:
- Return ONLY valid JSON
- No markdown wrapper
- Include searchesPerformed with real query strings used
- Set confidence honestly:
  high = pricing/reviews/core data/competitors verified
  medium = most verified with some gaps
  low = sparse information

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

function isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
}

function dedupeArray(values) {
    const seen = new Set();
    const out = [];
    for (const item of values || []) {
        const key = typeof item === "string"
            ? item.trim().toLowerCase()
            : JSON.stringify(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function mergeFillMissing(existing, patch) {
    if (patch === null || patch === undefined) return existing;

    if (Array.isArray(patch)) {
        if (isEmptyValue(existing)) return dedupeArray(patch);
        if (Array.isArray(existing)) return dedupeArray([...(existing || []), ...patch]);
        return existing;
    }

    if (typeof patch === "object") {
        const base = (existing && typeof existing === "object" && !Array.isArray(existing)) ? existing : {};
        const merged = { ...base };
        for (const [key, value] of Object.entries(patch)) {
            merged[key] = mergeFillMissing(base[key], value);
        }
        return merged;
    }

    return isEmptyValue(existing) ? patch : existing;
}

function hasDataReviewCoverageGaps(result) {
    if (!result) return true;
    const requiredChecks = [
        Boolean(result.about),
        Boolean(result.usp),
        Boolean(result.icp),
        Boolean(result.tone),
        Array.isArray(result.features) && result.features.length >= 3,
        Array.isArray(result.integrations) && result.integrations.length >= 1,
        Array.isArray(result.pricing) && result.pricing.length >= 1,
        Array.isArray(result.compliance) && result.compliance.length >= 1,
        Array.isArray(result.reviews) && result.reviews.length >= 1,
        (Array.isArray(result.caseStudies) && result.caseStudies.length >= 1) || (Array.isArray(result.notableCustomers) && result.notableCustomers.length >= 1),
        !isEmptyValue(result.teamSize) || !isEmptyValue(result.funding),
        !isEmptyValue(result.support) || !isEmptyValue(result.contact)
    ];
    const met = requiredChecks.filter(Boolean).length;
    return met < 8;
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
    const preferredFallbackOrder = ['openai', 'gemini', 'perplexity'];
    const fallbacks = preferredFallbackOrder.filter(p => p !== primary && providerMap[p]);
    return [primary, ...fallbacks];
}

function isTimeoutError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return (
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("etimedout") ||
        message.includes("deadline exceeded")
    );
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
    const fallbackEnabled = true;
    const fastFailOnGeminiQuota = true;
    const providerMap = getProviderFunctionMap();
    const forcedSkipProviders = Array.isArray(options.skipProviders)
        ? options.skipProviders.map((p) => String(p).toLowerCase())
        : [];
    const providerOrder = getProviderOrder().filter((provider) => !forcedSkipProviders.includes(provider));
    const providerOptions = options || {};

    if (providerOrder.length === 0) {
        throw new Error("No providers available after skipProviders filter");
    }

    const primaryProvider = providerOrder[0];
    const primaryFn = providerMap[primaryProvider];

    try {
        console.log(`[AI] [${context}] Trying primary provider: ${primaryProvider}`);
        const primaryResult = await primaryFn(prompt, providerOptions);
        console.log(`[AI] [${context}] Primary provider succeeded: ${primaryProvider}`);
        return primaryResult;
    } catch (e) {
        console.error(`[AI] [${context}] Primary provider failed (${primaryProvider}): ${e.message}`);
        if (typeof providerOptions.onPrimaryFailure === "function") {
            try {
                providerOptions.onPrimaryFailure({
                    provider: primaryProvider,
                    error: e,
                    context
                });
            } catch {
                // Keep provider routing resilient; ignore observer errors.
            }
        }
        if (primaryProvider === 'gemini' && fastFailOnGeminiQuota && isGeminiQuotaError(e)) {
            console.warn(`[AI] [${context}] Gemini quota detected on primary. Continuing to next fallback provider.`);
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
    result.funding = result.funding || result.fundingTotal || null;
    delete result.employeeRange;
    delete result.team_size;
    delete result.fundingTotal;

    // support: if object, flatten to string
    if (result.support && typeof result.support === 'object') {
        const parts = [];
        if (result.support.channels?.length) parts.push(result.support.channels.join(', '));
        if (result.support.hours) {
            parts.push(result.support.hours);
            result.activeHours = result.activeHours || result.support.hours;
        }
        if (result.support.notes) parts.push(result.support.notes);
        result.support = parts.join(' — ') || null;
    }

    // Ensure arrays exist
    const arrayFields = ['integrations', 'compliance', 'techStack', 'limitations',
        'commonObjections', 'blogTopics', 'segments', 'contentThemes',
        'partnerships', 'notableCustomers', 'competitors', 'searchesPerformed'];
    for (const field of arrayFields) {
        if (!Array.isArray(result[field])) result[field] = [];
    }

    // Ensure complex arrays exist
    const complexArrayFields = ['founders', 'reviews', 'caseStudies', 'contact'];
    for (const field of complexArrayFields) {
        if (!Array.isArray(result[field])) result[field] = [];
    }

    // Ensure profile objects
    result.social = result.social || {};
    result.contentProfiles = result.contentProfiles || {};
    result.developerProfiles = result.developerProfiles || {};
    result.reviewProfiles = result.reviewProfiles || {};
    result.businessProfiles = result.businessProfiles || {};
    result.appProfiles = result.appProfiles || {};

    const profileDefaults = {
        social: ['twitter', 'linkedin', 'facebook', 'instagram', 'threads', 'bluesky', 'tiktok'],
        contentProfiles: ['youtube', 'medium', 'substack', 'podcast', 'pinterest', 'dribbble'],
        developerProfiles: ['github', 'productHunt', 'discord', 'slackCommunity', 'reddit'],
        reviewProfiles: ['g2', 'capterra', 'trustpilot', 'glassdoor', 'yelp', 'bbb'],
        businessProfiles: ['crunchbase', 'wikipedia', 'googleBusiness', 'wellfound'],
        appProfiles: ['appStore', 'playStore']
    };
    for (const [objKey, keys] of Object.entries(profileDefaults)) {
        const source = result[objKey] && typeof result[objKey] === 'object' ? result[objKey] : {};
        const normalizedObj = {};
        for (const key of keys) {
            normalizedObj[key] = source[key] ?? null;
        }
        result[objKey] = normalizedObj;
    }

    // Ensure string fields
    const stringFields = ['name', 'domain', 'usp', 'icp', 'tone', 'about', 'industry',
        'niche', 'productModel', 'yearFounded', 'headquarters', 'teamSize',
        'funding', 'support', 'confidence', 'confidenceNotes',
        'strengthVsTarget', 'weaknessVsTarget', 'pricingComparison', 'marketPositionVsTarget',
        'guarantees', 'roadmap', 'changelog', 'activeHours', 'contentStrategy', 'researchDate'];
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
    const fastestMode = false;
    const onboardTimeoutMs = ONBOARD_TIMEOUT_MS;
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
        : DEFAULT_CLIENT_PROMPT_MODE;
    const prompt = buildResearchPrompt(domain, 'client', structuralData, null, promptMode);

    let result = null;
    let competitors = [];
    let skipOpenAIForThisRun = false;

    try {
        const primaryStartedAt = Date.now();
        result = await callPrimaryThenFallback(
            prompt,
            "research-domain-primary",
            {
                timeoutMs: onboardTimeoutMs,
                onPrimaryFailure: ({ provider, error }) => {
                    if (provider === "openai" && isTimeoutError(error)) {
                        skipOpenAIForThisRun = true;
                        console.warn("[AI] Circuit breaker: OpenAI timed out on primary stage; skipping OpenAI for remaining onboard stages.");
                    }
                }
            }
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
        if (isTimeoutError(e) || String(e.message || "").toLowerCase().includes("openai responses failed")) {
            skipOpenAIForThisRun = true;
            console.warn("[AI] Circuit breaker: OpenAI disabled for remaining onboard stages in this request.");
        }
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
                {
                    timeoutMs: onboardTimeoutMs,
                    skipProviders: skipOpenAIForThisRun ? ["openai"] : []
                }
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
                {
                    timeoutMs: onboardTimeoutMs,
                    skipProviders: skipOpenAIForThisRun ? ["openai"] : []
                }
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

    const defaultPromptMode = DEFAULT_CLIENT_PROMPT_MODE;
    const competitorResearchMode = DEFAULT_COMPETITOR_PROMPT_MODE;
    const activePromptMode = competitorResearchMode === 'default' ? defaultPromptMode : competitorResearchMode;
    const prompt = buildResearchPrompt(domain, 'competitor', structuralData, clientContext, activePromptMode);

    let result = null;
    try {
        result = await callPrimaryThenFallback(prompt, "research-competitor-primary");
        console.log(`[AI] Competitor research succeeded: "${result.name}"`);
    } catch (e) {
        console.error(`[AI] Primary/fallback failed for competitor ${domain}: ${e.message}`);
    }

    if (result && activePromptMode === 'lite' && shouldEscalateToMaster(result)) {
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

    let normalized = normalizeResearchOutput(result);

    // Quality pass: if competitor data lacks key Data Review coverage, run one targeted backfill.
    if (hasDataReviewCoverageGaps(normalized)) {
        try {
            console.log(`[AI] Competitor coverage gap detected for ${domain}; running one backfill pass...`);
            const backfill = await enrichEntityPostCall({
                mode: "competitor",
                domain,
                currentData: normalized,
                clientContext,
                enrichmentSummary: {
                    transcriptSummary: "- No interview transcript available",
                    blogsSummary: "- No blog signals available"
                }
            });
            if (backfill) {
                normalized = mergeFillMissing(normalized, backfill);
            }
        } catch (e) {
            console.error(`[AI] Competitor coverage backfill failed (non-fatal): ${e.message}`);
        }
    }

    console.log(`[AI] Competitor done: ${domain} | strength: ${normalized.strengthVsTarget ? 'YES' : 'NO'}`);
    return normalized;
}

function summarizeInterviewAndBlogs(elevenLabsData = {}, blogPosts = []) {
    const transcript = Array.isArray(elevenLabsData?.transcript) ? elevenLabsData.transcript : [];
    const transcriptLines = transcript
        .slice(-16)
        .map((msg) => {
            const role = msg?.role === "user" ? "Client" : "Agent";
            const text = String(msg?.text || "").replace(/\s+/g, " ").trim();
            return text ? `- ${role}: ${text.slice(0, 260)}` : null;
        })
        .filter(Boolean);

    const blogLines = (Array.isArray(blogPosts) ? blogPosts : [])
        .slice(0, 10)
        .map((post) => {
            const title = String(post?.title || "").trim();
            const desc = String(post?.description || "").replace(/\s+/g, " ").trim();
            const url = String(post?.url || "").trim();
            const bits = [title, desc, url].filter(Boolean);
            return bits.length > 0 ? `- ${bits.join(" | ").slice(0, 320)}` : null;
        })
        .filter(Boolean);

    return {
        transcriptSummary: transcriptLines.length > 0 ? transcriptLines.join("\n") : "- No interview transcript available",
        blogsSummary: blogLines.length > 0 ? blogLines.join("\n") : "- No blog signals available"
    };
}

async function enrichEntityPostCall({
    mode,
    domain,
    currentData,
    clientContext,
    enrichmentSummary
}) {
    const currentDataJson = JSON.stringify(currentData || {}, null, 2).slice(0, 12000);
    const enrichmentContext = `CURRENT DATA SNAPSHOT (fill only missing/weak fields):
${currentDataJson}

INTERVIEW SUMMARY:
${enrichmentSummary.transcriptSummary}

BLOG SIGNALS SUMMARY:
${enrichmentSummary.blogsSummary}`;

    const prompt = buildResearchPrompt(
        domain,
        mode,
        null,
        clientContext || null,
        "postcall_enrichment",
        enrichmentContext
    );

    const result = await callPrimaryThenFallback(
        prompt,
        `postcall-enrichment-${mode}`,
        { timeoutMs: 45000 }
    );
    return normalizeResearchOutput(result);
}

async function enrichDataReviewPostCall({
    clientData,
    compData,
    competitors,
    elevenLabsData
}) {
    const clientDomain = clientData?.domain;
    if (!clientDomain) {
        throw new Error("clientData.domain is required for post-call enrichment");
    }

    const blogPosts = Array.isArray(clientData?.blogPosts) ? clientData.blogPosts : [];
    const enrichmentSummary = summarizeInterviewAndBlogs(elevenLabsData || {}, blogPosts);
    const clientContext = {
        name: clientData?.name || clientDomain,
        domain: clientDomain,
        niche: clientData?.data?.niche || null,
        usp: clientData?.data?.usp || null
    };

    const clientDataPatch = await enrichEntityPostCall({
        mode: "client",
        domain: clientDomain,
        currentData: clientData?.data || {},
        clientContext: null,
        enrichmentSummary
    });

    const competitorList = Array.isArray(competitors) ? competitors : [];
    const competitorPatchesByDomain = {};
    const failedCompetitors = [];

    for (const competitor of competitorList) {
        const domain = normalizeDomainKey(competitor?.domain);
        if (!domain) continue;
        try {
            const currentComp = compData?.[domain]?.data || {};
            competitorPatchesByDomain[domain] = await enrichEntityPostCall({
                mode: "competitor",
                domain,
                currentData: currentComp,
                clientContext,
                enrichmentSummary
            });
        } catch (error) {
            failedCompetitors.push({ domain, error: error.message });
        }
    }

    return {
        clientDataPatch,
        competitorPatchesByDomain,
        contextSummary: enrichmentSummary,
        failedCompetitors
    };
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
        timeout: timeoutMs,
        maxRetries: 0
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
        console.warn(`[AI] Responses API failed (no non-web fallback): ${error.message}`);
        throw new Error(`OpenAI responses failed: ${error.message}`);
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    researchDomain,
    researchCompetitor,
    enrichDataReviewPostCall,
    buildResearchPrompt,     // exported for testing
    normalizeResearchOutput, // exported for testing
    parseJson
};
