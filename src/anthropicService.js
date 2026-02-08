const Anthropic = require('@anthropic-ai/sdk');

/**
 * Deep research prompt optimized for Claude OPUS
 * Uses more context and asks for detailed competitive analysis
 */
function getDeepResearchPrompt(domain) {
    return `You are a senior market researcher conducting deep competitive intelligence on a company.

RESEARCH TARGET: https://${domain}

Your task is to provide an EXHAUSTIVE analysis of this company and their competitive landscape.
Use your knowledge to research every aspect you can find.

RESEARCH METHODOLOGY:
1. Analyze the company's website, product pages, pricing, about section
2. Find their exact market positioning and ideal customer profile
3. Identify their complete feature set and technical integrations
4. Research their founding team, funding history, and company size
5. Find real review scores from G2, Capterra, TrustRadius
6. Discover their most successful case studies and customer wins
7. Identify ALL direct competitors who sell the same product to the same buyer
8. Research limitations, known issues, or gaps in their offering

COMPETITOR ANALYSIS REQUIREMENTS:
For each competitor, you MUST provide:
- Their exact website domain
- Their company name
- A specific reason why they compete (same product + same buyer)
- What makes them different from the target company

CRITICAL RULES:
- Be extremely thorough - this is for a sales team preparation
- Only include VERIFIED information you are confident about
- For anything uncertain, use null
- Competitors must be DIRECT - not adjacent categories
- Include pricing tiers if publicly available
- Include ALL integrations you can find

Return ONLY valid JSON with this structure:
{
    "name": "Company Name (official)",
    "usp": "Their unique selling proposition - what makes them different",
    "icp": "Ideal Customer Profile - who buys this and why",
    "tone": "Brand voice description - formal, casual, technical, friendly, etc.",
    "about": "Company description in 3-4 sentences covering what they do and their mission",
    "industry": "Primary industry they serve",
    "niche": "Ultra-specific product niche in 10-20 words - be very precise",
    "founded": "Year founded or null",
    "headquarters": "City, Country or null",
    "employeeCount": "Approximate employee count or range, or null",
    "features": ["Feature 1", "Feature 2", "...complete list"],
    "integrations": ["Integration 1", "Integration 2", "...complete list"],
    "pricing": [
        {
            "tier": "Plan Name",
            "price": "$X",
            "period": "/month or /year",
            "features": ["What's included"],
            "bestFor": "Who this tier is for"
        }
    ],
    "founders": [
        {
            "name": "Full Name",
            "role": "Title",
            "background": "Previous experience, education, notable achievements",
            "linkedin": "LinkedIn URL or null"
        }
    ],
    "funding": {
        "totalRaised": "$X or null",
        "lastRound": "Series X or null",
        "investors": ["Investor names"] 
    },
    "compliance": ["SOC2", "GDPR", "HIPAA", "etc."],
    "reviews": [
        {
            "platform": "G2",
            "score": "4.8",
            "count": "150",
            "topPros": ["What users love"],
            "topCons": ["Common complaints"]
        }
    ],
    "caseStudies": [
        {
            "company": "Customer name",
            "industry": "Their industry",
            "result": "Specific outcome achieved",
            "quote": "Customer testimonial if available"
        }
    ],
    "competitors": [
        {
            "domain": "competitor.com",
            "name": "Competitor Name",
            "reason": "Both offer [specific product] to [specific buyer persona]",
            "differentiator": "What makes them different from target company",
            "strengthVsTarget": "Where they're stronger",
            "weaknessVsTarget": "Where they're weaker"
        }
    ],
    "social": {
        "twitter": "handle or null",
        "linkedin": "company URL or null",
        "github": "handle or null",
        "youtube": "channel URL or null"
    },
    "techStack": ["Known technologies used"],
    "limitations": ["Known limitations or gaps"],
    "support": {
        "channels": ["email", "chat", "phone"],
        "hours": "24/7 or business hours",
        "sla": "Response time guarantees if known"
    },
    "contact": [
        {"label": "Sales Email", "value": "sales@domain.com"},
        {"label": "Support", "value": "support@domain.com"},
        {"label": "Phone", "value": "+1-xxx-xxx-xxxx"}
    ],
    "blogTopics": ["Recent content themes they publish about"],
    "targetMarkets": ["Geographic or industry markets they focus on"],
    "partnerships": ["Named technology or channel partners"],
    "confidence": "high | medium | low"
}

RESPOND ONLY WITH THE JSON, no markdown, no explanation, no extra text.`;
}

/**
 * Parse JSON from Claude response
 */
function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in response");
    return JSON.parse(match[0]);
}

/**
 * Research a domain using Claude OPUS for maximum detail
 */
async function tryClaudeOpus(domain) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.log("[AI] No ANTHROPIC_API_KEY, skipping Claude OPUS");
        return null;
    }

    console.log("[AI] Trying Claude OPUS for deep research...");
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
        model: "claude-3-opus-20240229",
        max_tokens: 8000,
        messages: [
            {
                role: "user",
                content: getDeepResearchPrompt(domain)
            }
        ]
    });

    const responseText = message.content[0].text;
    const result = parseJson(responseText);

    console.log(`[AI] Claude OPUS succeeded! Company: "${result.name}" | Niche: "${result.niche}"`);
    console.log(`[AI] Claude found ${result.competitors?.length || 0} competitors`);
    console.log(`[AI] Tokens used: ${message.usage?.input_tokens || 0} in, ${message.usage?.output_tokens || 0} out`);

    return result;
}

module.exports = { tryClaudeOpus, getDeepResearchPrompt };
