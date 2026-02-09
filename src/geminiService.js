const { GoogleGenAI } = require("@google/genai");

// ============================================
// Shared utilities
// ============================================

function getGeminiClient() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
}

function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Gemini response");
    return JSON.parse(match[0]);
}

function logGrounding(label, response) {
    const metadata = response.candidates?.[0]?.groundingMetadata;
    if (metadata?.webSearchQueries) {
        console.log(`[Gemini:${label}] Search queries:`, metadata.webSearchQueries.slice(0, 5));
    }
    if (metadata?.groundingChunks?.length > 0) {
        console.log(`[Gemini:${label}] Grounded with ${metadata.groundingChunks.length} sources`);
    }
}

// ============================================
// PROMPT 1: Company Investigation
// ============================================

function getCompanyResearchPrompt(domain) {
    return `You are a senior market research analyst. Research https://${domain} using web search.

RESEARCH STEPS (follow each):
1. Search "${domain}" and visit the website. Read homepage, about, features, pricing pages.
2. Search "${domain} what is", "${domain} company overview"
3. Search "${domain} pricing", "${domain} plans", "how much does ${domain} cost"
4. Search "${domain} features", "${domain} integrations", "${domain} API"
5. Search "${domain} reviews G2", "${domain} reviews Capterra", "${domain} Trustpilot"
6. Search "${domain} founders", "${domain} leadership", "${domain} Crunchbase"
7. Search "${domain} funding", "${domain} Series", "${domain} investors"
8. Search "${domain} SOC 2", "${domain} GDPR", "${domain} HIPAA", "${domain} security"
9. Search "${domain} complaints", "${domain} problems", "${domain} limitations"
10. Search "${domain} Twitter", "${domain} LinkedIn", "${domain} GitHub", "${domain} contact"
11. Search "${domain} tech stack", "BuiltWith ${domain}", "Wappalyzer ${domain}"
12. Search "${domain} support", "${domain} contact", "${domain} help center"
13. Search "${domain} case study", "${domain} customer stories"

IMPORTANT:
- Do NOT research competitors. A separate prompt handles that.
- Do NOT look for blog posts. A separate prompt handles that.
- Define the company's SPECIFIC NICHE in 5-15 words: [technology/approach] + [product type] + [target buyer]
  Examples: "AI-powered phone answering service for solo law firms", "Cloud-based data pipeline platform for enterprise analytics teams"
  This niche will be used later to find competitors.

QUALITY RULES:
- NEVER invent data. If a search returns nothing, use null or [].
- NEVER guess at founders, pricing, metrics, or case studies.
- ALWAYS prefer specificity over generality.
- Set confidence honestly: high = found pricing + reviews + clear product info; medium = some gaps; low = sparse info.

Return ONLY valid JSON:
{
  "name": "Company name",
  "domain": "${domain}",
  "usp": "Unique Selling Proposition or null",
  "icp": "Ideal Customer Profile or null",
  "tone": "Brand voice description or null",
  "about": "2-4 sentence description or null",
  "industry": "Primary industry or null",
  "niche": "Ultra-specific 5-15 word niche description",
  "yearFounded": "YYYY or null",
  "headquarters": "City, Country or null",
  "employeeRange": "e.g. 11-50 or null",
  "fundingTotal": "e.g. $15M Series A or null",
  "features": ["verified product features"],
  "integrations": ["verified integrations"],
  "pricing": [{"tier":"Plan name", "price":"$X", "period":"/month", "features":["included features"], "highlight": false}],
  "founders": [{"name":"Full name", "role":"Title", "background":"Brief background", "linkedin":"URL or null"}],
  "compliance": ["soc2", "gdpr", "hipaa", "ccpa", "iso27001"],
  "reviews": [{"platform":"G2", "score":"4.8", "count":"150", "summary":"One-sentence theme"}],
  "caseStudies": [{"company":"Customer name", "result":"Quantified outcome", "industry":"Industry", "source":"URL"}],
  "social": {"twitter":"handle or null", "linkedin":"URL or null", "github":"handle or null", "youtube":"URL or null", "facebook":"URL or null"},
  "techStack": ["verified technologies"],
  "limitations": ["verified limitations from real feedback"],
  "support": {"channels":["live chat","email"], "hours":"24/7 or null", "notes":"null"},
  "contact": [{"label":"Sales Email", "value":"sales@domain.com", "icon":"mail"}],
  "confidence": "high|medium|low",
  "confidenceNotes": "What you could and couldn't verify",
  "researchDate": "${new Date().toISOString().split('T')[0]}",
  "searchesPerformed": ["list of queries you ran"]
}`;
}

async function geminiCompanyResearch(domain) {
    const ai = getGeminiClient();
    if (!ai) throw new Error("No GOOGLE_API_KEY configured");

    console.log("[Gemini:Company] Researching company info...");
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: getCompanyResearchPrompt(domain),
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const responseText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) throw new Error("No text in Gemini company research response");

    logGrounding("Company", response);
    const result = parseJson(responseText);
    console.log(`[Gemini:Company] Done! "${result.name}" | Niche: "${result.niche}" | Features: ${result.features?.length || 0}`);
    return result;
}

// ============================================
// PROMPT 2: Blog Discovery
// ============================================

function getBlogDiscoveryPrompt(domain) {
    return `You are a blog discovery specialist. Search the web to find REAL blog posts published on ${domain}.

SEARCH STRATEGY (try ALL of these):
1. site:${domain} blog
2. site:${domain}/blog
3. site:${domain} article
4. site:${domain}/resources
5. site:${domain}/insights
6. site:${domain}/guides
7. site:${domain}/learn
8. site:${domain}/news
9. "${domain}" blog post
10. "${domain}" insights article

STRICT RULES:
- Return ONLY URLs of actual written articles/blog posts/guides with substantial content
- URLs must be on ${domain} (same domain only)
- URLs must be individual content pages (e.g. /blog/article-name, /resources/guide-title)
- Do NOT include: homepage, product pages, pricing pages, demo pages, landing pages, about pages, contact pages, login/signup, category listing pages, tag pages, author pages
- Only return posts you can CONFIRM exist via search. If you find 3, return 3. Never invent URLs.
- If the site has NO blog section, return an empty array.
- Try to find up to 20 blog posts, prioritizing recent ones.

Return ONLY valid JSON:
{
  "blogPosts": [
    {
      "url": "https://${domain}/blog/exact-article-slug",
      "title": "The actual article title",
      "description": "Brief description of what the article covers"
    }
  ]
}

If no blog posts found, return: {"blogPosts": []}`;
}

async function geminiBlogDiscovery(domain) {
    const ai = getGeminiClient();
    if (!ai) throw new Error("No GOOGLE_API_KEY configured");

    console.log("[Gemini:Blogs] Searching for blog posts...");
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: getBlogDiscoveryPrompt(domain),
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const responseText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) throw new Error("No text in Gemini blog discovery response");

    logGrounding("Blogs", response);
    const result = parseJson(responseText);
    console.log(`[Gemini:Blogs] Found ${result.blogPosts?.length || 0} blog posts`);
    return result;
}

// ============================================
// PROMPT 3: Competitor Discovery
// ============================================

function getCompetitorDiscoveryPrompt(domain, niche) {
    return `You are a competitive intelligence analyst. Your ONLY job is to find DIRECT competitors for the company at https://${domain}.

THE COMPANY'S NICHE: ${niche}

SEARCH PROCESS (follow each step):
1. Search "${domain} competitors"
2. Search "${domain} alternatives"
3. Search "${domain} vs"
4. Search "best ${niche} software 2025"
5. Search "alternatives to ${domain}"
6. Search "${domain}" on G2 category pages
7. Search "${domain}" on AlternativeTo
8. Search "${domain}" on Capterra
9. Search "top ${niche} companies"
10. Search "${niche} market landscape"

VALIDATION RULES - for EACH potential competitor:
  INCLUDE only if ALL are true:
  - Sells the SAME type of product (not an adjacent product)
  - Targets the SAME buyer persona / industry vertical
  - A real buyer would have BOTH on their shortlist
  - Competes at the SAME market level (SMB vs enterprise alignment)
  - You actually FOUND this company via search (not guessing from training data)

  EXCLUDE if ANY are true:
  - It's a broad platform that has an overlapping feature (e.g., Salesforce, HubSpot, Zendesk)
  - It's in a broader parent category
  - It targets a fundamentally different buyer
  - You didn't actually find it via search -- you're guessing

For each validated competitor, also search:
- "[competitor] vs ${domain}"
- "[competitor] pricing"

Return 3-8 direct competitors. If fewer than 3 exist, return what you found. Do NOT pad with irrelevant companies.

Return ONLY valid JSON:
{
  "competitors": [
    {
      "domain": "competitor.com",
      "name": "Competitor Name",
      "reason": "Both sell [specific product] to [specific buyer persona]",
      "differentiator": "How they differ from ${domain}",
      "estimatedSize": "smaller|similar|larger or null"
    }
  ],
  "searchesPerformed": ["list of queries you ran"]
}`;
}

async function geminiCompetitorDiscovery(domain, niche) {
    const ai = getGeminiClient();
    if (!ai) throw new Error("No GOOGLE_API_KEY configured");

    console.log(`[Gemini:Competitors] Discovering competitors for niche: "${niche}"...`);
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: getCompetitorDiscoveryPrompt(domain, niche),
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const responseText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) throw new Error("No text in Gemini competitor discovery response");

    logGrounding("Competitors", response);
    const result = parseJson(responseText);
    console.log(`[Gemini:Competitors] Found ${result.competitors?.length || 0} competitors`);
    return result;
}

// ============================================
// PROMPT 4: Competitor Deep Research (per competitor)
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
7. Search "${competitorDomain} tech stack", "BuiltWith ${competitorDomain}"
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

async function geminiCompetitorDeepResearch(competitorDomain, clientDomain, niche) {
    const ai = getGeminiClient();
    if (!ai) throw new Error("No GOOGLE_API_KEY configured");

    console.log(`[Gemini:DeepComp] Researching ${competitorDomain}...`);
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: getCompetitorDeepResearchPrompt(competitorDomain, clientDomain, niche),
        config: {
            tools: [{ googleSearch: {} }],
        },
    });

    const responseText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) throw new Error(`No text in Gemini deep research response for ${competitorDomain}`);

    logGrounding("DeepComp", response);
    const result = parseJson(responseText);
    console.log(`[Gemini:DeepComp] ${competitorDomain} done! Features: ${result.features?.length || 0}, Pricing tiers: ${result.pricing?.length || 0}`);
    return result;
}

module.exports = {
    geminiCompanyResearch,
    geminiBlogDiscovery,
    geminiCompetitorDiscovery,
    geminiCompetitorDeepResearch,
};
