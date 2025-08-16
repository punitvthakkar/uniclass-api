import { createClient } from '@supabase/supabase-js'

// This function attempts the batch embedding using the official, documented request format.
async function getBatchEmbeddings(texts) {
  try {
    const modelName = 'models/text-embedding-004';
    console.log(`Getting batch embeddings for a chunk of ${texts.length} texts.`);
    
    const requestBody = {
      requests: texts.map(text => ({
        model: modelName,
        content: {
          parts: [{ text: text }]
        }
      }))
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${modelName}:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error response: ${errorText}`);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.embeddings && Array.isArray(data.embeddings)) {
      return data.embeddings.map(emb => emb.values);
    } else {
      console.error('Unexpected response format from Gemini batch API:', data);
      throw new Error('Unexpected response format from Gemini API');
    }
    
  } catch (error) {
    console.error('Batch embedding function error:', error);
    return new Array(texts.length).fill(null);
  }
}

// Main handler function
export default async function handler(req, res) {
  // Set CORS headers and handle preflight OPTIONS request
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { queries } = req.body;
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid queries array' });
    }

    console.log(`Processing batch of ${queries.length} queries.`);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const queryTexts = queries.map(q => q.query);

    const CHUNK_SIZE = 100;
    const embeddingPromises = [];
    for (let i = 0; i < queryTexts.length; i += CHUNK_SIZE) {
      const chunk = queryTexts.slice(i, i + CHUNK_SIZE);
      embeddingPromises.push(getBatchEmbeddings(chunk));
    }

    const embeddingChunks = await Promise.all(embeddingPromises);
    const embeddings = embeddingChunks.flat();
    
    // --- CRITICAL FORENSIC LOGGING ---
    if (embeddings && embeddings.length > 1 && embeddings[0] && embeddings[1]) {
        console.log("--- EMBEDDING FORENSICS ---");
        const firstEmbeddingSnippet = embeddings[0].slice(0, 5).join(', ');
        const secondEmbeddingSnippet = embeddings[1].slice(0, 5).join(', ');
        
        console.log(`Snippet of Vector[0]: [${firstEmbeddingSnippet}... ]`);
        console.log(`Snippet of Vector[1]: [${secondEmbeddingSnippet}... ]`);
        
        if (JSON.stringify(embeddings[0]) === JSON.stringify(embeddings[1])) {
            console.log("!!! VERDICT: The first two embedding vectors are IDENTICAL. This proves the bug is in the Gemini API. !!!");
        } else {
            console.log("--- VERDICT: The embedding vectors are unique. ---");
        }
        console.log("--------------------------");
    }
    // --- END OF LOGGING ---

    const results = [];
    for (let i = 0; i < queries.length; i++) {
        const { uniclass_type, output_format = 'COBIE', request_id } = queries[i];
        const queryEmbedding = embeddings[i];
        try {
            if (!queryEmbedding) {
                results.push({ request_id: request_id || i, match: 'Embedding failed:0.00', confidence: 0, alternatives: [] });
                continue;
            }

            const { data, error } = await supabase.rpc('match_uniclass', { query_embedding: queryEmbedding, uniclass_type_filter: uniclass_type.toUpperCase(), match_threshold: 0.1, match_count: 3 });
            
            if (error) {
                console.error('Supabase error for query', i, ':', error);
                results.push({ request_id: request_id || i, match: 'Database error:0.00', confidence: 0, alternatives: [] });
                continue;
            }
            if (!data || data.length === 0) {
                results.push({ request_id: request_id || i, match: 'No match found:0.00', confidence: 0, alternatives: [] });
                continue;
            }

            const best = data[0];
            let result_text;
            switch (output_format.toUpperCase()) {
                case 'CODE': result_text = best.code; break;
                case 'TITLE': result_text = best.title; break;
                default: result_text = `${best.code}:${best.title}`;
            }
            const scoreFormatted = best.similarity.toFixed(2);
            const finalResult = `${result_text}:${scoreFormatted}`;
            results.push({ request_id: request_id || i, match: finalResult, confidence: best.similarity, alternatives: data.slice(1).map(item => ({ code: item.code, title: item.title, confidence: item.similarity })) });

        } catch (innerError) {
            console.error('Error processing query', i, ':', innerError);
            results.push({ request_id: request_id || i, match: 'Processing error:0.00', confidence: 0, alternatives: [] });
        }
    }
    return res.json({ success: true, processed: results.length, results: results });

  } catch (error) {
    console.error('Batch API Handler Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
