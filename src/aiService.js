const {
    geminiCompanyResearch,
    geminiBlogDiscovery,
    geminiCompetitorDiscovery,
    geminiCompetitorDeepResearch,
} = require("./geminiService");
const { findBlogsWithPerplexity } = require("./blogService");

/**
 * Full research pipeline using specialized Gemini prompts.
 *
 * Phase 1 (parallel): Company research + Blog discovery
 * Phase 2 (sequential): Competitor discovery (needs niche from Phase 1)
 * Phase 3 (parallel): Deep research on each competitor
 *
 * Returns: { companyData, blogPosts, competitors, competitorDetails }
 */
async function generateFullResearch(domain) {
    console.log(`[AI] ═══ Starting specialized research for: ${domain} ═══`);

    // ─── PHASE 1: Company + Blogs in parallel ───
    console.log("[AI] Phase 1: Company research + Blog discovery (parallel)...");
    const [companyResult, blogResult] = await Promise.allSettled([
        geminiCompanyResearch(domain),
        geminiBlogDiscovery(domain),
    ]);

    const companyData = companyResult.status === "fulfilled" ? companyResult.value : null;
    if (!companyData) {
        const msg = companyResult.reason?.message || "unknown error";
        console.error(`[AI] Company research FAILED: ${msg}`);
        throw new Error(`Company research failed: ${msg}`);
    }

    let blogPosts = blogResult.status === "fulfilled"
        ? (blogResult.value?.blogPosts || [])
        : [];

    if (blogResult.status === "rejected") {
        console.warn(`[AI] Blog discovery failed: ${blogResult.reason?.message}`);
    }

    // Blog fallback: if Gemini found nothing, try Perplexity
    if (blogPosts.length === 0) {
        console.log("[AI] Gemini found no blogs, trying Perplexity fallback...");
        try {
            const perplexityBlogs = await findBlogsWithPerplexity(domain, 20);
            blogPosts = perplexityBlogs || [];
            console.log(`[AI] Perplexity fallback found ${blogPosts.length} blogs`);
        } catch (e) {
            console.warn(`[AI] Perplexity blog fallback also failed: ${e.message}`);
        }
    }

    console.log(`[AI] Phase 1 complete: company="${companyData.name}", blogs=${blogPosts.length}`);

    // ─── PHASE 2: Competitor discovery (needs niche from Phase 1) ───
    const niche = companyData.niche || `${companyData.industry || "technology"} software`;
    console.log(`[AI] Phase 2: Competitor discovery for niche: "${niche}"...`);

    let competitors = [];
    try {
        const competitorResult = await geminiCompetitorDiscovery(domain, niche);
        competitors = competitorResult?.competitors || [];
        console.log(`[AI] Phase 2 complete: ${competitors.length} competitors found`);
    } catch (e) {
        console.error(`[AI] Competitor discovery failed: ${e.message}`);
    }

    // ─── PHASE 3: Deep research on each competitor (parallel) ───
    const competitorDetails = {};
    if (competitors.length > 0) {
        console.log(`[AI] Phase 3: Deep research on ${competitors.length} competitors (parallel)...`);

        const detailResults = await Promise.allSettled(
            competitors.map(comp =>
                geminiCompetitorDeepResearch(comp.domain, domain, niche)
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

    console.log(`[AI] ═══ Research complete: company + ${blogPosts.length} blogs + ${competitors.length} competitors ═══`);

    return {
        companyData,
        blogPosts,
        competitors,
        competitorDetails,
    };
}

/**
 * Backward-compatible wrapper: returns company data with competitors embedded.
 * Used by POST /api/onboard in index.js.
 */
async function generateClientData(domain) {
    const result = await generateFullResearch(domain);

    return {
        ...result.companyData,
        competitors: result.competitors,
        _blogPosts: result.blogPosts,
        _competitorDetails: result.competitorDetails,
        _meta: {
            provider: "gemini-specialized",
            phases: 3,
            competitorsResearched: Object.keys(result.competitorDetails).length,
            blogsFound: result.blogPosts.length,
            timestamp: new Date().toISOString(),
        },
    };
}

module.exports = { generateClientData, generateFullResearch };
