const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { tryClaudeOpus } = require("./anthropicService");

function getPrompt(domain) {
    return `
You MUST use Google Search to research the company at https://${domain}. Do NOT rely on your training data alone.

STEP 1: Search for "${domain}" and visit the actual website to understand what they do.
STEP 2: Search for "${domain} competitors" and "${domain} alternatives" to find real competitors.
STEP 3: Search for "${domain} pricing", "${domain} reviews G2 Capterra", "${domain} founders" for additional info.

CRITICAL RULES:
- Only include information you found via web search or from the company's actual website.
- If you cannot verify something, use null or empty array.
- Do NOT invent founders, pricing, reviews, or case studies.
- Do NOT guess — if the search returns nothing, leave it empty.

COMPETITORS — FOLLOW THIS PROCESS:
1. First determine the company's SPECIFIC product niche (write it in the "niche" field). Be ultra-specific — e.g. "AI phone receptionist for car dealerships", NOT "AI company".
2. Search for "[company name] competitors" and "[company name] alternatives" on Google.
3. ONLY list competitors who sell the SAME type of product to the SAME buyer persona.
4. VALIDATE: "Would a customer evaluating this company also have the competitor on their shortlist?"
5. DO NOT include companies from broader/adjacent categories (e.g. Salesforce, HubSpot, Zendesk are NOT competitors to niche vertical tools).
6. If you cannot find real direct competitors, return an EMPTY array.

Return ONLY valid JSON with this structure:
{
    "name": "Company name",
    "usp": "Unique Selling Proposition or null",
    "icp": "Ideal Customer Profile or null",
    "tone": "Brand tone description or null",
    "about": "Company description (2-3 sentences) or null",
    "industry": "Primary industry or null",
    "niche": "Ultra-specific product niche in 5-15 words",
    "features": ["Known features"],
    "integrations": ["Known integrations"],
    "pricing": [{"tier": "Name", "price": "Amount", "period": "/month", "features": ["..."]}],
    "founders": [{"name": "Name", "role": "Role", "background": "Info"}],
    "compliance": ["soc2", "gdpr"],
    "reviews": [{"platform": "G2", "score": "4.8", "count": "150"}],
    "caseStudies": [{"company": "Client", "result": "Result", "industry": "Industry"}],
    "competitors": [{"domain": "competitor.com", "name": "Name", "reason": "Both sell [product] to [buyer]"}],
    "social": {"twitter": "handle or null", "linkedin": "url or null", "github": "handle or null"},
    "techStack": ["Known technologies"],
    "limitations": ["Known limitations"],
    "support": "Support info or null",
    "contact": [{"label": "Email", "value": "email@domain.com", "icon": "mail"}],
    "blogTopics": ["Recent blog topics or themes found"],
    "confidence": "high | medium | low"
}

RESPOND ONLY WITH THE JSON, no markdown, no extra text.`;
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
