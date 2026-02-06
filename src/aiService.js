const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

function getPrompt(domain) {
    return `
You are an expert B2B analyst. Research the company at "${domain}" and provide ONLY factual, verifiable information.

CRITICAL RULES:
- Only include information you can verify. If you don't know something, use null or empty array.
- Do NOT invent founders, pricing, reviews, or case studies.
- For competitors, only list real, well-known companies in the same space.

Return ONLY valid JSON with this structure:
{
    "name": "Company name",
    "usp": "Unique Selling Proposition or null",
    "icp": "Ideal Customer Profile or null",
    "tone": "Brand tone description or null",
    "about": "Company description (2-3 sentences) or null",
    "industry": "Primary industry or null",
    "features": ["Known features"] ,
    "integrations": ["Known integrations"],
    "pricing": [{"tier": "Name", "price": "Amount", "period": "/month", "features": ["..."]}],
    "founders": [{"name": "Name", "role": "Role", "background": "Info"}],
    "compliance": ["soc2", "gdpr"],
    "reviews": [{"platform": "G2", "score": "4.8", "count": "150"}],
    "caseStudies": [{"company": "Client", "result": "Result", "industry": "Industry"}],
    "competitors": [{"domain": "competitor.com", "name": "Name", "reason": "Why they compete"}],
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

async function tryGemini(domain) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.log("[AI] No GOOGLE_API_KEY, skipping Gemini");
        return null;
    }

    console.log("[AI] Trying Gemini with Google Search grounding...");
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: getPrompt(domain),
        config: {
            tools: [{ googleSearch: {} }],
            responseMimeType: "application/json",
        },
    });

    const text = response.text;
    const jsonStr = text.replace(/```json|```/g, "").trim();
    console.log("[AI] Gemini succeeded!");

    const metadata = response.candidates?.[0]?.groundingMetadata;
    if (metadata?.webSearchQueries) {
        console.log("[AI] Search queries used:", metadata.webSearchQueries);
    }

    return JSON.parse(jsonStr);
}

async function tryOpenAI(domain) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("[AI] No OPENAI_API_KEY, skipping OpenAI");
        return null;
    }

    console.log("[AI] Trying OpenAI fallback...");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "You are an expert B2B analyst. Respond ONLY with valid JSON. Only include factual, verifiable information." },
            { role: "user", content: getPrompt(domain) },
        ],
        response_format: { type: "json_object" },
    });

    console.log("[AI] OpenAI succeeded!");
    return JSON.parse(completion.choices[0].message.content);
}

async function generateClientData(domain) {
    try {
        const result = await tryGemini(domain);
        if (result) return result;
    } catch (error) {
        console.error("[AI] Gemini failed:", error.message);
    }

    try {
        const result = await tryOpenAI(domain);
        if (result) return result;
    } catch (error) {
        console.error("[AI] OpenAI failed:", error.message);
    }

    console.error("[AI] All providers failed");
    return null;
}

module.exports = { generateClientData };
