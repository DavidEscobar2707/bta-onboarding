const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { tryClaudeOpus } = require("./anthropicService");

function getPrompt(domain) {
    return `You are a senior market research analyst. Your task is to produce a comprehensive intelligence report on the company at https://${domain}. 

You MUST use web search extensively. Do NOT rely on training data. Every claim must be sourced from live search results or the company's actual website. If you cannot verify something, use null or an empty array — never fabricate data.

═══════════════════════════════════════
RESEARCH PROCESS (follow in order)
═══════════════════════════════════════

PHASE 1 — COMPANY FOUNDATION
─────────────────────────────
1. Search "${domain}" and visit the website. Read the homepage, about page, and product/features pages.
2. Search "${domain} what is" and "${domain} company overview" to understand their core offering.
3. Identify and document:
   - What they sell (product type, delivery model — SaaS, API, hardware, etc.)
   - Who they sell to (buyer persona, company size, industry vertical)
   - Their primary value proposition (why someone buys THIS vs. building or doing nothing)
   - Brand tone and positioning (enterprise vs. SMB, technical vs. non-technical, playful vs. corporate)

PHASE 2 — COMMERCIAL DETAILS
─────────────────────────────
4. Search "${domain} pricing", "${domain} plans", "how much does ${domain} cost"
   - Look for pricing pages, comparison blog posts, and community discussions
5. Search "${domain} integrations", "${domain} API", "${domain} tech stack"
   - Check for integrations pages, developer docs, and BuiltWith/Wappalyzer data
6. Search "${domain} features", "${domain} product tour", "${domain} changelog"
   - Look for feature comparison pages and recent product updates

PHASE 3 — CREDIBILITY & SOCIAL PROOF
─────────────────────────────────────
7. Search "${domain} reviews G2", "${domain} reviews Capterra", "${domain} Trustpilot"
   - Record platform, score, review count, and any recurring praise/complaints
8. Search "${domain} case study", "${domain} customer stories", "${domain} testimonials"
   - Document real customer names, industries, and quantified results only
9. Search "${domain} SOC 2", "${domain} GDPR", "${domain} HIPAA", "${domain} security"
   - Note any compliance certifications or security pages

PHASE 4 — PEOPLE & BACKSTORY
─────────────────────────────
10. Search "${domain} founders", "${domain} leadership team", "${domain} Crunchbase"
    - Cross-reference with LinkedIn and Crunchbase profiles
11. Search "${domain} funding", "${domain} Series", "${domain} investors"
    - Note funding rounds, amounts, and lead investors if available
12. Search "${domain} blog", "${domain} content" 
    - Identify 5-10 recent blog topics/themes to understand their content strategy

PHASE 5 — CONTACT & SOCIAL PRESENCE
────────────────────────────────────
13. Search "${domain} Twitter", "${domain} LinkedIn", "${domain} GitHub"
    - Collect social handles and approximate follower counts if visible
14. Search "${domain} support", "${domain} contact", "${domain} help center"
    - Note support channels (chat, email, phone, community forum, knowledge base)

PHASE 6 — COMPETITOR IDENTIFICATION (CRITICAL — READ CAREFULLY)
───────────────────────────────────────────────────────────────
This is the most important phase. Follow each step precisely:

Step A: Define the SPECIFIC product niche in 5-15 words.
   - GOOD: "AI-powered phone answering service for solo law firms"
   - BAD: "AI company" / "customer service software" / "SaaS platform"
   - The niche must include: [technology/approach] + [product type] + [target buyer]

Step B: Run these searches:
   - "[company name] competitors"
   - "[company name] alternatives"
   - "[company name] vs"
   - "best [product niche keywords] software"
   - "alternatives to [company name] for [ICP]"
   - Check G2 category pages and comparison sites (e.g., G2, AlternativeTo, Capterra)

Step C: For EACH potential competitor, apply this validation:
   ┌──────────────────────────────────────────────────────────────┐
   │ INCLUDE only if ALL of these are true:                       │
   │ ✓ Sells the SAME type of product (not adjacent)              │
   │ ✓ Targets the SAME buyer persona / industry vertical         │
   │ ✓ A real buyer would have BOTH on their shortlist             │
   │ ✓ Competes at the SAME level (SMB vs. enterprise alignment)  │
   │                                                               │
   │ EXCLUDE if ANY of these are true:                             │
   │ ✗ It's a platform/suite that happens to have an overlapping   │
   │   feature (e.g., Salesforce, HubSpot, Zendesk)               │
   │ ✗ It's in a broader/parent category                           │
   │ ✗ It targets a fundamentally different buyer                  │
   │ ✗ You're only guessing — you didn't find it via search        │
   └──────────────────────────────────────────────────────────────┘

Step D: For each validated competitor, search "[competitor] vs ${domain}" and 
        "[competitor] pricing" to gather differentiating context.

Step E: If you find fewer than 2 real direct competitors, that's fine — 
        return what you found. Do NOT pad the list with tangential companies.

PHASE 7 — LIMITATIONS & GAPS
─────────────────────────────
15. Search "${domain} complaints", "${domain} problems", "${domain} limitations"
    - Look at review sites, Reddit, forums for recurring pain points
16. Search "${domain} missing features", "${domain} feature request"
    - Note what customers wish the product had

═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════

Return ONLY valid JSON. No markdown wrapping. No explanation before or after.

{
  "name": "Company name",
  "domain": "${domain}",
  "usp": "Unique Selling Proposition — what makes them different from alternatives, or null",
  "icp": "Ideal Customer Profile — specific buyer persona, company size, industry, or null",
  "tone": "Brand voice description (e.g., 'Professional but approachable, targets non-technical SMB owners') or null",
  "about": "Company description in 2-4 sentences covering what they do, for whom, and how, or null",
  "industry": "Primary industry vertical or null",
  "niche": "Ultra-specific product niche in 5-15 words (see Phase 6, Step A)",
  "yearFounded": "YYYY or null",
  "headquarters": "City, State/Country or null",
  "employeeRange": "e.g., '11-50', '51-200' or null",
  "fundingTotal": "e.g., '$15M Series A' or null",
  "features": ["List of verified product features — be specific, not generic"],
  "integrations": ["Verified integrations with other tools/platforms"],
  "pricing": [
    {
      "tier": "Plan name",
      "price": "Dollar amount or 'Custom'",
      "period": "/month or /year or /user/month",
      "features": ["Key features included in this tier"],
      "highlight": true
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
  "compliance": ["soc2", "gdpr", "hipaa", "ccpa", "iso27001"],
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
      "industry": "Customer's industry",
      "source": "URL where this case study was found"
    }
  ],
  "competitors": [
    {
      "domain": "competitor.com",
      "name": "Competitor Name",
      "reason": "Both sell [specific product] to [specific buyer persona]",
      "differentiator": "How they differ from ${domain} (pricing, features, positioning)",
      "estimatedSize": "Relative size indicator — 'smaller', 'similar', 'larger' or null"
    }
  ],
  "social": {
    "twitter": "handle or null",
    "linkedin": "URL or null",
    "github": "handle or null",
    "youtube": "URL or null",
    "facebook": "URL or null"
  },
  "techStack": ["Known/detected technologies (e.g., 'React', 'AWS', 'Stripe')"],
  "limitations": ["Verified limitations or common complaints from real user feedback"],
  "support": {
    "channels": ["live chat", "email", "phone", "knowledge base", "community forum"],
    "hours": "24/7 or business hours or null",
    "notes": "Any notable support details or null"
  },
  "contact": [
    {"label": "Sales Email", "value": "sales@domain.com", "icon": "mail"},
    {"label": "Phone", "value": "+1-xxx-xxx-xxxx", "icon": "phone"},
    {"label": "Demo", "value": "https://domain.com/demo", "icon": "calendar"}
  ],
  "blogTopics": ["5-10 recent blog themes that reveal their content/SEO strategy"],
  "contentStrategy": "Brief description of their content marketing approach or null",
  "confidence": "high | medium | low",
  "confidenceNotes": "Explain what you could and couldn't verify — be transparent about gaps",
  "researchDate": "YYYY-MM-DD",
  "searchesPerformed": ["List the actual search queries you ran for auditability"]
}

═══════════════════════════════════════
QUALITY RULES
═══════════════════════════════════════

1. NEVER invent data. If a search returns nothing, use null or [].
2. NEVER guess at founders, pricing, metrics, or case studies.
3. ALWAYS prefer specificity over generality (features, niche, ICP).
4. Competitors must pass the validation test in Phase 6, Step C.
5. Include "searchesPerformed" so the output is auditable.
6. Set "confidence" honestly:
   - "high" = found pricing, reviews, clear product info, and competitors
   - "medium" = found most info but some gaps (e.g., no pricing page, limited reviews)
   - "low" = sparse information available, early-stage company, or limited web presence`;
}

function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in response");
    return JSON.parse(match[0]);
}

/**
 * Merge results from multiple LLMs, taking the most complete data from each
 */
function mergeResearchResults(results) {
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];

    console.log(`[AI] Merging results from ${results.length} providers...`);

    const merged = { ...results[0] };

    for (let i = 1; i < results.length; i++) {
        const result = results[i];

        // For string fields, prefer non-null/non-empty values
        const stringFields = ['name', 'usp', 'icp', 'tone', 'about', 'industry', 'niche', 'support', 'confidence'];
        for (const field of stringFields) {
            if (!merged[field] && result[field]) {
                merged[field] = result[field];
            } else if (result[field] && result[field].length > (merged[field]?.length || 0)) {
                // Prefer longer/more detailed descriptions
                merged[field] = result[field];
            }
        }

        // For arrays, combine unique items
        const arrayFields = ['features', 'integrations', 'compliance', 'techStack', 'limitations', 'blogTopics'];
        for (const field of arrayFields) {
            const existing = merged[field] || [];
            const newItems = result[field] || [];
            const combined = [...new Set([...existing, ...newItems])];
            merged[field] = combined;
        }

        // For complex arrays (pricing, founders, reviews, caseStudies, competitors, contact)
        // Combine and deduplicate by key field
        const complexArrayFields = [
            { field: 'pricing', key: 'tier' },
            { field: 'founders', key: 'name' },
            { field: 'reviews', key: 'platform' },
            { field: 'caseStudies', key: 'company' },
            { field: 'competitors', key: 'domain' },
            { field: 'contact', key: 'label' }
        ];

        for (const { field, key } of complexArrayFields) {
            const existing = merged[field] || [];
            const newItems = result[field] || [];
            const seen = new Set(existing.map(item => item[key]?.toLowerCase()));

            for (const item of newItems) {
                const itemKey = item[key]?.toLowerCase();
                if (itemKey && !seen.has(itemKey)) {
                    existing.push(item);
                    seen.add(itemKey);
                }
            }
            merged[field] = existing;
        }

        // Merge social object
        if (result.social) {
            merged.social = { ...(merged.social || {}), ...result.social };
            // Remove nulls
            for (const key of Object.keys(merged.social)) {
                if (!merged.social[key]) delete merged.social[key];
            }
        }
    }

    console.log(`[AI] Merged result: ${merged.features?.length || 0} features, ${merged.competitors?.length || 0} competitors`);
    return merged;
}

async function tryGemini(domain) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.log("[AI] No GOOGLE_API_KEY, skipping Gemini");
        return null;
    }

    console.log("[AI] Trying Gemini 2.5 Flash with Google Search + URL Context...");
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: getPrompt(domain),
        config: {
            tools: [{ googleSearch: {} }, { urlContext: {} }],
        },
    });

    const result = parseJson(response.text);
    console.log(`[AI] Gemini succeeded! Company: "${result.name}" | Niche: "${result.niche}"`);

    const metadata = response.candidates?.[0]?.groundingMetadata;
    if (metadata?.webSearchQueries) {
        console.log("[AI] Search queries:", metadata.webSearchQueries);
    }
    if (metadata?.groundingChunks?.length > 0) {
        console.log(`[AI] Grounded with ${metadata.groundingChunks.length} sources`);
    }

    return result;
}

async function tryOpenAI(domain) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("[AI] No OPENAI_API_KEY, skipping OpenAI");
        return null;
    }

    console.log("[AI] Trying OpenAI GPT-4o with web search...");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.responses.create({
        model: "gpt-4o",
        tools: [{ type: "web_search" }],
        input: getPrompt(domain),
    });

    const result = parseJson(response.output_text);
    console.log(`[AI] OpenAI succeeded! Company: "${result.name}" | Niche: "${result.niche}"`);
    return result;
}

/**
 * Generate client data using ALL available AI providers
 * Merges results from multiple sources for maximum data extraction
 */
async function generateClientData(domain) {
    console.log(`[AI] ═══ Starting multi-LLM research for: ${domain} ═══`);

    const results = [];
    const errors = [];

    // Try Gemini (fastest, has web search)
    try {
        const geminiResult = await tryGemini(domain);
        if (geminiResult) {
            results.push(geminiResult);
            console.log("[AI] ✓ Gemini contributed data");
        }
    } catch (error) {
        console.error("[AI] ✗ Gemini failed:", error.message);
        errors.push({ provider: 'Gemini', error: error.message });
    }

    // Try OpenAI (good general knowledge)
    try {
        const openaiResult = await tryOpenAI(domain);
        if (openaiResult) {
            results.push(openaiResult);
            console.log("[AI] ✓ OpenAI contributed data");
        }
    } catch (error) {
        console.error("[AI] ✗ OpenAI failed:", error.message);
        errors.push({ provider: 'OpenAI', error: error.message });
    }

    // Try Claude OPUS (deepest analysis)
    try {
        const claudeResult = await tryClaudeOpus(domain);
        if (claudeResult) {
            results.push(claudeResult);
            console.log("[AI] ✓ Claude OPUS contributed data");
        }
    } catch (error) {
        console.error("[AI] ✗ Claude OPUS failed:", error.message);
        errors.push({ provider: 'Claude OPUS', error: error.message });
    }

    // Merge all results
    if (results.length > 0) {
        const merged = mergeResearchResults(results);
        merged._meta = {
            providers: results.length,
            errors: errors.length,
            timestamp: new Date().toISOString()
        };
        console.log(`[AI] ═══ Research complete: ${results.length} providers, ${errors.length} failures ═══`);
        return merged;
    }

    console.error("[AI] All providers failed");
    return null;
}

module.exports = { generateClientData, mergeResearchResults };
