const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

const BLOG_PROMPT = (domain, limit) => `
You MUST use Google Search to find real blog posts published by the company at https://${domain}.

Search these specific URLs:
- https://${domain}/blog
- https://${domain}/resources
- https://${domain}/insights
- https://${domain}/news
- Also search for: "${domain} blog posts" on Google

RULES:
- You MUST search the web. Do NOT rely on training data.
- Only include REAL blog posts with verifiable URLs that you found via search.
- If you cannot find real posts, return an empty blogPosts array.
- Do NOT invent blog posts or fake URLs.
- For images: always use "https://picsum.photos/seed/{id}/800/400" as placeholder.

Return ONLY valid JSON:
{
    "blogPosts": [
        {
            "id": 1,
            "title": "Real blog post title",
            "date": "2024-01-15",
            "image": "https://picsum.photos/seed/1/800/400",
            "description": "Brief description of the post",
            "body": "First paragraph or summary of the post content",
            "url": "https://${domain}/blog/real-post-slug"
        }
    ]
}

Find up to ${limit} posts. RESPOND ONLY WITH JSON.`;

function parseJson(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in response");
    return JSON.parse(match[0]);
}

async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] Finding blog posts for: ${domain}`);
    const errors = [];

    // Try 1: Gemini 2.5 Flash with Google Search + URL Context
    const geminiKey = process.env.GOOGLE_API_KEY;
    if (geminiKey) {
        try {
            const ai = new GoogleGenAI({ apiKey: geminiKey });
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: BLOG_PROMPT(domain, limit),
                config: {
                    tools: [{ googleSearch: {} }, { urlContext: {} }],
                },
            });

            const parsed = parseJson(response.text);
            if (parsed.blogPosts?.length > 0) {
                console.log(`[Blog] Gemini found ${parsed.blogPosts.length} posts`);
                return parsed.blogPosts;
            }
            console.log("[Blog] Gemini returned 0 posts, trying OpenAI...");
        } catch (error) {
            console.error("[Blog] Gemini failed:", error.message);
            errors.push(`Gemini: ${error.message}`);
        }
    }

    // Try 2: OpenAI GPT-4o with web search
    if (process.env.OPENAI_API_KEY) {
        try {
            console.log("[Blog] Trying OpenAI with web search...");
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const response = await openai.responses.create({
                model: "gpt-4o",
                tools: [{ type: "web_search" }],
                input: BLOG_PROMPT(domain, limit),
            });

            const parsed = parseJson(response.output_text);
            if (parsed.blogPosts?.length > 0) {
                console.log(`[Blog] OpenAI found ${parsed.blogPosts.length} posts`);
                return parsed.blogPosts;
            }
            console.log("[Blog] OpenAI returned 0 posts");
        } catch (error) {
            console.error("[Blog] OpenAI failed:", error.message);
            errors.push(`OpenAI: ${error.message}`);
        }
    }

    // Both failed — return empty instead of throwing
    console.warn(`[Blog] No posts found for "${domain}". ${errors.join("; ")}`);
    return [];
}

module.exports = { getBlogPosts };
