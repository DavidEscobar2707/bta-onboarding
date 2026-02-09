const Anthropic = require('@anthropic-ai/sdk');

/**
 * Deep research prompt optimized for Claude OPUS
 * Uses more context and asks for detailed competitive analysis
 */
function getDeepResearchPrompt(domain) {
  return `You are a competitive intelligence analyst. Research https://${domain} exhaustively using web search.

RESEARCH PROCESS:
1. Visit the website and search "${domain}", "${domain} about", "${domain} how it works"
2. Search "${domain} pricing", "${domain} features", "${domain} integrations", "${domain} API"
3. Search "${domain} reviews G2", "${domain} reviews Capterra", "${domain} Trustpilot"
4. Search "${domain} founders", "${domain} Crunchbase", "${domain} funding"
5. Search "${domain} case study", "${domain} customers", "${domain} testimonials"
6. Search "${domain} competitors", "${domain} alternatives", "${domain} vs"
7. Search "${domain} complaints", "${domain} limitations", "${domain} reddit"
8. Search "${domain} security", "${domain} SOC 2", "${domain} GDPR"
9. Search "${domain} blog", "${domain} Twitter", "${domain} LinkedIn", "${domain} contact"

For each confirmed competitor, also search "[competitor] vs ${domain}", "[competitor] pricing", "[competitor] reviews G2".

COMPETITOR RULES:
- Define the company's SPECIFIC niche first: [technology] + [product type] + [target buyer]
- A valid competitor must: sell the SAME product type, to the SAME buyer persona, at the SAME market tier
- A real buyer would have both on their shortlist
- REJECT broad platforms with overlapping features (Salesforce, HubSpot, etc.)
- Empty array is better than wrong competitors

DATA INTEGRITY:
- Only include information confirmed via search. Never invent data.
- Use null for anything you can't verify.
- Set confidence honestly based on what you actually found.

Return ONLY valid JSON:

{
  "name": "Official Company Name",
  "domain": "${domain}",
  "usp": "Unique selling proposition or null",
  "icp": {
    "buyerPersona": "Decision-maker job title(s) or null",
    "companySize": "SMB | Mid-Market | Enterprise or null",
    "industries": ["Target verticals"],
    "triggerEvents": ["What causes someone to buy this"]
  },
  "tone": "Brand voice description or null",
  "about": "3-4 sentence company description or null",
  "industry": "Primary industry or null",
  "niche": "Ultra-specific: [technology] + [product type] + [target buyer]",
  "productModel": "SaaS | API | Marketplace | Other or null",
  "yearFounded": "YYYY or null",
  "headquarters": "Location or null",
  "employeeRange": "e.g. '51-200' or null",
  "features": [{"category": "Category name", "items": ["Specific features"]}],
  "integrations": ["Verified integrations"],
  "pricing": {
    "model": "Per seat | Per usage | Flat rate | Custom or null",
    "freeTrial": true,
    "tiers": [{"tier": "Name", "price": "Amount", "period": "/month", "features": ["..."], "recommended": false}],
    "contractNotes": "Annual discounts, minimums, etc. or null"
  },
  "founders": [{"name": "Name", "role": "Title", "background": "Info", "linkedin": "URL or null"}],
  "funding": {
    "totalRaised": "$XM or null",
    "lastRound": "Series X - $XM - Date or null",
    "investors": ["Notable investors"],
    "stage": "Seed | Series A | Bootstrapped | etc. or null"
  },
  "compliance": ["SOC 2", "GDPR", "HIPAA"],
  "reviews": [{"platform": "G2", "score": "4.8", "count": "150", "positiveThemes": ["..."], "negativeThemes": ["..."]}],
  "caseStudies": [{"company": "Client", "result": "Quantified outcome", "industry": "Industry", "source": "URL"}],
  "notableCustomers": ["Named logos found publicly"],
  "competitors": [
    {
      "domain": "competitor.com",
      "name": "Name",
      "reason": "Both offer [product] to [buyer]",
      "differentiator": "Key positioning difference",
      "strengthVsTarget": "Where they're stronger (specific)",
      "weaknessVsTarget": "Where they're weaker (specific)",
      "pricingComparison": "Cheaper | Similar | More expensive | Unknown"
    }
  ],
  "social": {"twitter": "null", "linkedin": "null", "github": "null", "youtube": "null"},
  "support": {"channels": ["live chat", "email"], "hours": "24/7 or null"},
  "contact": [{"label": "Sales", "value": "email@domain.com", "type": "email"}],
  "limitations": ["Verified limitations from real user feedback"],
  "commonObjections": ["Sales objections a buyer might raise"],
  "blogTopics": ["5-10 recent content themes"],
  "confidence": "high | medium | low",
  "confidenceNotes": "What you verified vs. what had gaps",
  "searchesPerformed": ["Every query you ran"],
  "researchDate": "YYYY-MM-DD"
}`;
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
    model: "claude-sonnet-4-20250514",
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
