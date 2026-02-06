const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

const BLOG_PROMPT = (domain, limit) => `
You are a content analyst. Find real blog posts published by "${domain}".

Search for actual blog articles from this company's website or content platforms (Medium, Substack, etc).

RULES:
- Only include REAL blog posts you can verify exist.
- If you cannot find real posts, return an empty array.
- Do NOT invent blog posts or URLs.

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

async function getBlogPosts(domain, limit = 20) {
    console.log(`[Blog] Finding blog posts for: ${domain}`);

    // Try Gemini with grounding
    const apiKey = process.env.GOOGLE_API_KEY;
    if (apiKey) {
        try {
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model: "gemini-2.0-flash",
                contents: BLOG_PROMPT(domain, limit),
                config: {
                    tools: [{ googleSearch: {} }],
                    responseMimeType: "application/json",
                },
            });

            const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
            console.log(`[Blog] Gemini found ${parsed.blogPosts?.length || 0} posts`);
            return parsed.blogPosts || [];
        } catch (error) {
            console.error("[Blog] Gemini failed:", error.message);
        }
    }

    // Fallback: OpenAI
    if (process.env.OPENAI_API_KEY) {
        try {
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a content analyst. Respond ONLY with valid JSON." },
                    { role: "user", content: BLOG_PROMPT(domain, limit) },
                ],
                response_format: { type: "json_object" },
            });

            const parsed = JSON.parse(completion.choices[0].message.content);
            console.log(`[Blog] OpenAI found ${parsed.blogPosts?.length || 0} posts`);
            return parsed.blogPosts || [];
        } catch (error) {
            console.error("[Blog] OpenAI failed:", error.message);
        }
    }

    console.log("[Blog] No AI provider available");
    return [];
}

module.exports = { getBlogPosts };
