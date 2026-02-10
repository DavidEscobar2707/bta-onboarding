/**
 * FASE 2: Compresión brutal del contenido
 * Convierte artículos largos en "hechos" estructurados
 * No guarda texto crudo, solo insights extraídos
 */

const OpenAI = require("openai");

function extractJson(text) {
    if (!text) return null;
    const cleaned = text.replace(/```json|```/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

/**
 * Comprime un artículo en 5 bullets clave + metadata
 * Input: texto completo del artículo
 * Output: JSON estructurado (sin el texto original)
 */
async function compressArticle(url, title, content, wordCount) {
    if (!process.env.OPENAI_API_KEY) {
        return createBasicCompression(url, title, content, wordCount);
    }

    // Si el artículo es muy corto, no merece compresión con LLM
    if (wordCount < 300) {
        return createBasicCompression(url, title, content, wordCount);
    }

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        
        // Truncar contenido si es muy largo (ahorro de tokens)
        const truncatedContent = content.slice(0, 8000);
        
        const response = await openai.responses.create({
            model: "gpt-4o-mini", // Más barato para compresión
            input: `Analyze this article and extract key insights. Do NOT return the original text.

URL: ${url}
Title: ${title}
Word count: ${wordCount}

Content (truncated):
${truncatedContent}

Return JSON ONLY:
{
    "topic": "main topic in 3-5 words",
    "audience": "target audience",
    "intent": "educational | commercial | thought_leadership",
    "key_pains": ["pain point 1", "pain point 2"],
    "solutions_mentioned": ["solution 1", "solution 2"],
    "key_takeaways": ["insight 1", "insight 2", "insight 3", "insight 4", "insight 5"],
    "cta": "main call to action mentioned",
    "tone": "professional | casual | technical | persuasive",
    "novelty_score": 1-10
}`
        });

        const parsed = extractJson(response.output_text);
        if (parsed) {
            return {
                url,
                title,
                wordCount,
                compressed: true,
                ...parsed,
                // NO incluimos content original - eso es el punto
                content_preview: content.slice(0, 200) + '...'
            };
        }
    } catch (error) {
        console.log(`[Compressor] Failed to compress ${url}: ${error.message}`);
    }

    return createBasicCompression(url, title, content, wordCount);
}

function createBasicCompression(url, title, content, wordCount) {
    // Fallback sin LLM - extracción básica
    const sentences = content
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 30 && s.length < 150)
        .slice(0, 5);

    return {
        url,
        title,
        wordCount,
        compressed: false,
        topic: title,
        audience: 'unknown',
        intent: 'unknown',
        key_pains: [],
        solutions_mentioned: [],
        key_takeaways: sentences,
        cta: null,
        tone: 'unknown',
        novelty_score: 5,
        content_preview: content.slice(0, 200) + '...'
    };
}

/**
 * Comprime múltiples artículos de forma eficiente
 * Procesa en paralelo con rate limiting
 */
async function compressArticles(articles) {
    console.log(`[Compressor] Compressing ${articles.length} articles...`);
    
    const compressed = [];
    
    // Procesar en batches de 3 para no saturar la API
    for (let i = 0; i < articles.length; i += 3) {
        const batch = articles.slice(i, i + 3);
        const batchResults = await Promise.all(
            batch.map(article => 
                compressArticle(article.url, article.title, article.content, article.wordCount)
            )
        );
        compressed.push(...batchResults);
        
        // Pequeña pausa entre batches
        if (i + 3 < articles.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    console.log(`[Compressor] Compressed ${compressed.length} articles`);
    return compressed;
}

/**
 * Genera un "Content Strategy Profile" a partir de artículos comprimidos
 * Resumen agregado de todo el contenido editorial
 */
function generateContentProfile(compressedArticles) {
    const topics = {};
    const pains = {};
    const audiences = {};
    const intents = {};

    compressedArticles.forEach(article => {
        // Count topics
        const topic = article.topic || 'unknown';
        topics[topic] = (topics[topic] || 0) + 1;

        // Count pains
        (article.key_pains || []).forEach(pain => {
            pains[pain] = (pains[pain] || 0) + 1;
        });

        // Count audiences
        const aud = article.audience || 'unknown';
        audiences[aud] = (audiences[aud] || 0) + 1;

        // Count intents
        const intent = article.intent || 'unknown';
        intents[intent] = (intents[intent] || 0) + 1;
    });

    return {
        total_articles: compressedArticles.length,
        top_topics: Object.entries(topics)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([t, c]) => ({ topic: t, count: c })),
        top_pains: Object.entries(pains)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([p, c]) => ({ pain: p, count: c })),
        audience_breakdown: audiences,
        intent_breakdown: intents,
        avg_novelty_score: compressedArticles.reduce((sum, a) => sum + (a.novelty_score || 5), 0) / compressedArticles.length,
        editorial_maturity: compressedArticles.length > 8 ? 'high' : compressedArticles.length > 3 ? 'medium' : 'low'
    };
}

module.exports = { 
    compressArticle, 
    compressArticles, 
    generateContentProfile 
};
