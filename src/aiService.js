const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

// Shared prompt template
function getPrompt(domain, pageContent) {
    return `
    Act as an expert B2B product consultant and competitive analyst. Analyze the following content extracted from ${domain} and generate a complete onboarding JSON.
    
    IMPORTANT: The JSON must have EXACTLY this structure and fields for the frontend to work. If you cannot find an exact piece of data, infer it creatively based on the company context.

    REQUIRED STRUCTURE:
    {
        "name": "Company name",
        "usp": "Unique Selling Proposition (1 powerful sentence)",
        "icp": "Detailed Ideal Customer Profile",
        "tone": "Description of tone of voice (e.g., Professional, Disruptive)",
        "about": "Company summary (2-3 sentences)",
        "industry": "Primary industry (e.g., SaaS, FinTech, Marketing)",
        "features": ["Feature 1", "Feature 2", ...],
        "integrations": ["Salesforce", "Slack", ...],
        "pricing": [
            { "tier": "Starter", "price": "29", "period": "/month", "features": ["Feature A"] },
            { "tier": "Pro", "price": "99", "period": "/month", "features": ["Feature A", "Feature B"] }
        ],
        "founders": [
            { "name": "Name", "role": "CEO/CTO", "background": "Ex-Google, etc" }
        ],
        "compliance": ["soc2", "gdpr"],
        "reviews": [
            { "platform": "G2", "score": "4.8", "count": "150" }
        ],
        "caseStudies": [
            { "company": "Client A", "result": "Key result", "industry": "SaaS", "link": "" }
        ],
        "competitors": [
            { "domain": "competitor1.com", "name": "Competitor Name", "reason": "Why they compete" },
            { "domain": "competitor2.com", "name": "Another Competitor", "reason": "Why they compete" }
        ],
        "social": { "twitter": "handle", "linkedin": "url", "github": "handle" },
        "techStack": ["React", "Node.js"],
        "limitations": ["Possible limitation 1"],
        "support": "Hours and channels",
        "contact": [ { "label": "Email", "value": "hello@${domain}", "icon": "mail" } ]
    }

    IMPORTANT ABOUT COMPETITORS:
    - Identify 3-5 real competitors based on the industry and product type
    - Use real domains of well-known companies in the same space
    - If you cannot determine exact competitors, suggest the most likely ones based on the industry

    RESPOND ONLY WITH THE JSON, no additional text or markdown.

    SITE CONTENT:
    ${pageContent.substring(0, 10000)}
    `;
}

// Try with Gemini
async function tryGemini(domain, pageContent) {
    if (!process.env.GOOGLE_API_KEY) {
        console.log("[AI] No GOOGLE_API_KEY found, skipping Gemini");
        return null;
    }

    console.log("[AI] Trying Gemini...");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(getPrompt(domain, pageContent));
    const response = await result.response;
    const text = response.text();
    const jsonStr = text.replace(/```json|```/g, '').trim();
    console.log("[AI] Gemini succeeded!");
    return JSON.parse(jsonStr);
}

// Fallback with OpenAI
async function tryOpenAI(domain, pageContent) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("[AI] No OPENAI_API_KEY found, skipping OpenAI");
        return null;
    }

    console.log("[AI] Trying OpenAI fallback...");
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Fast and economical, you can change to "gpt-4o" if you prefer
        messages: [
            {
                role: "system",
                content: "You are an expert B2B product consultant. You respond ONLY with valid JSON, no markdown or additional text."
            },
            {
                role: "user",
                content: getPrompt(domain, pageContent)
            }
        ],
        response_format: { type: "json_object" }
    });

    const text = completion.choices[0].message.content;
    const jsonStr = text.replace(/```json|```/g, '').trim();
    console.log("[AI] OpenAI succeeded!");
    return JSON.parse(jsonStr);
}

// Main function with fallback
async function generateClientData(domain, pageContent) {
    // Attempt 1: Gemini
    try {
        const geminiResult = await tryGemini(domain, pageContent);
        if (geminiResult) return geminiResult;
    } catch (error) {
        console.error("[AI] Gemini failed:", error.message);
    }

    // Attempt 2: OpenAI (fallback)
    try {
        const openaiResult = await tryOpenAI(domain, pageContent);
        if (openaiResult) return openaiResult;
    } catch (error) {
        console.error("[AI] OpenAI failed:", error.message);
    }

    // Both failed
    console.error("[AI] All AI providers failed");
    return null;
}

module.exports = { generateClientData };
