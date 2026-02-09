const OpenAI = require("openai");
const {
    geminiCompanyResearch,
    geminiCompetitorDiscovery,
} = require("./geminiService");
const { findBlogsWithPerplexity } = require("./blogService");

// ============================================
// Perplexity client for competitor deep research
// ============================================

function getPerplexityClient() {
    if (!process.env.PERPLEXITY_API_KEY) return null;
    return new OpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY,
        baseURL: "https://api.perplexity.ai",
    });
}

function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in response");
    return JSON.parse(match[0]);
}

// ============================================
// Perplexity: Deep competitor research (per competitor)
// ============================================

function getCompetitorDeepResearchPrompt(competitorDomain, clientDomain, niche) {
    return `You are a competitive intelligence analyst. Research https://${competitorDomain} in detail.
This company competes with ${clientDomain} in the niche: ${niche}

RESEARCH STEPS:
1. Visit ${competitorDomain} website - read homepage, about, features, pricing pages
2. Search "${competitorDomain} pricing", "${competitorDomain} plans"
3. Search "${competitorDomain} features", "${competitorDomain} integrations"
4. Search "${competitorDomain} reviews G2", "${competitorDomain} Capterra", "${competitorDomain} Trustpilot"
5. Search "${competitorDomain} SOC 2", "${competitorDomain} GDPR", "${competitorDomain} security"
6. Search "${competitorDomain} vs ${clientDomain}"
7. Search "${competitorDomain} tech stack"
8. Search "${competitorDomain} what is", "${competitorDomain} company overview"
9. Search "${competitorDomain} founders", "${competitorDomain} leadership"

DATA INTEGRITY: Only include verified information. Use null or [] for anything unconfirmed.

Return ONLY valid JSON:
{
  "name": "Company name",
  "domain": "${competitorDomain}",
  "usp": "Unique Selling Proposition or null",
  "about": "2-4 sentence description or null",
  "industry": "Primary industry or null",
  "icp": "Ideal Customer Profile or null",
  "features": ["verified features"],
  "integrations": ["verified integrations"],
  "pricing": [{"tier":"Plan name", "price":"$X", "period":"/month", "features":["included features"]}],
  "reviews": [{"platform":"G2", "score":"4.8", "count":"150", "summary":"One-sentence theme"}],
  "compliance": ["soc2", "gdpr", "hipaa"],
  "techStack": ["verified technologies"],
  "social": {"twitter":"handle or null", "linkedin":"URL or null"},
  "founders": [{"name":"Full name", "role":"Title", "background":"Brief background"}],
  "limitations": ["verified limitations"],
  "strengthVsTarget": "Where ${competitorDomain} is stronger than ${clientDomain} or null",
  "weaknessVsTarget": "Where ${competitorDomain} is weaker than ${clientDomain} or null",
  "pricingComparison": "Cheaper|Similar|More expensive|Unknown vs ${clientDomain}",
  "confidence": "high|medium|low",
  "searchesPerformed": ["queries run"]
}`;
}

async function perplexityCompetitorDeepResearch(competitorDomain, clientDomain, niche) {
    const client = getPerplexityClient();
    if (!client) throw new Error("No PERPLEXITY_API_KEY configured");

    console.log(`[Perplexity:DeepComp] Researching ${competitorDomain}...`);

    const response = await client.chat.completions.create({
        model: "sonar-pro",
        messages: [
            {
                role: "system",
                content: "You are a competitive intelligence analyst. Use web search to find accurate, up-to-date information. Return ONLY valid JSON."
            },
            {
                role: "user",
                content: getCompetitorDeepResearchPrompt(competitorDomain, clientDomain, niche)
            }
        ],
    });

    const responseText = response.choices?.[0]?.message?.content;
    if (!responseText) throw new Error(`No text in Perplexity response for ${competitorDomain}`);

    const result = parseJson(responseText);
    console.log(`[Perplexity:DeepComp] ${competitorDomain} done! Features: ${result.features?.length || 0}, Pricing: ${result.pricing?.length || 0}`);
    return result;
}

// ============================================
// Orchestrator: 3-phase pipeline
//
// Gemini (2 calls): Company research + Competitor discovery
// Perplexity (1 + N calls): Blogs + Deep research per competitor
// ============================================

async function generateFullResearch(domain) {
    console.log(`[AI] ═══ Starting research for: ${domain} ═══`);
    console.log("[AI] Strategy: Gemini (company + competitors) | Perplexity (blogs + deep research)");

    // ─── PHASE 1: Gemini company research + Perplexity blogs (parallel) ───
    console.log("[AI] Phase 1: Company research (Gemini) + Blog discovery (Perplexity) in parallel...");
    const [companyResult, blogResult] = await Promise.allSettled([
        geminiCompanyResearch(domain),
        findBlogsWithPerplexity(domain, 20),
    ]);

    const companyData = companyResult.status === "fulfilled" ? companyResult.value : null;
    if (!companyData) {
        const msg = companyResult.reason?.message || "unknown error";
        console.error(`[AI] Company research FAILED: ${msg}`);
        throw new Error(`Company research failed: ${msg}`);
    }

    let blogPosts = blogResult.status === "fulfilled" ? (blogResult.value || []) : [];
    if (blogResult.status === "rejected") {
        console.warn(`[AI] Blog discovery failed: ${blogResult.reason?.message}`);
    }

    console.log(`[AI] Phase 1 complete: company="${companyData.name}", blogs=${blogPosts.length}`);

    // ─── PHASE 2: Gemini competitor discovery (needs niche from Phase 1) ───
    const niche = companyData.niche || `${companyData.industry || "technology"} software`;
    console.log(`[AI] Phase 2: Competitor discovery (Gemini) for niche: "${niche}"...`);

    let competitors = [];
    try {
        const competitorResult = await geminiCompetitorDiscovery(domain, niche);
        competitors = competitorResult?.competitors || [];
        console.log(`[AI] Phase 2 complete: ${competitors.length} competitors found`);
    } catch (e) {
        console.error(`[AI] Competitor discovery failed: ${e.message}`);
    }

    // ─── PHASE 3: Perplexity deep research on each competitor (parallel) ───
    const competitorDetails = {};
    if (competitors.length > 0) {
        console.log(`[AI] Phase 3: Deep research on ${competitors.length} competitors (Perplexity, parallel)...`);

        const detailResults = await Promise.allSettled(
            competitors.map(comp =>
                perplexityCompetitorDeepResearch(comp.domain, domain, niche)
                    .then(data => ({ domain: comp.domain, data, success: true }))
                    .catch(err => {
                        console.error(`[AI] Deep research failed for ${comp.domain}: ${err.message}`);
                        return { domain: comp.domain, data: null, success: false };
                    })
            )
        );

        for (const result of detailResults) {
            const val = result.status === "fulfilled" ? result.value : null;
            if (val?.success && val.data) {
                competitorDetails[val.domain] = val.data;
            }
        }

        console.log(`[AI] Phase 3 complete: ${Object.keys(competitorDetails).length}/${competitors.length} competitors researched`);
    }

    console.log(`[AI] ═══ Research complete: company + ${blogPosts.length} blogs + ${competitors.length} competitors (${Object.keys(competitorDetails).length} detailed) ═══`);
    console.log(`[AI] Gemini calls used: 2 | Perplexity calls: ${1 + Object.keys(competitorDetails).length}`);

    return {
        companyData,
        blogPosts,
        competitors,
        competitorDetails,
    };
}

module.exports = { generateFullResearch };
