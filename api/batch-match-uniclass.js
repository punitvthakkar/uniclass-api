import { createClient } from '@supabase/supabase-js'

// getBatchEmbeddings function remains the same as it is working correctly.
async function getBatchEmbeddings(texts) { /* ... same as before ... */ }
// For brevity, I'm hiding the unchanged getBatchEmbeddings function.
// The full code block is below this explanation.

export default async function handler(req, res) {
  // ... CORS and method checks ...

  try {
    const { queries } = req.body;
    // ... input validation ...

    console.log("--- Vercel Function Triggered ---");
    console.log("Raw incoming queries from Excel:", JSON.stringify(queries, null, 2));

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const queryTexts = queries.map(q => q.query);
    
    // ... Get embeddings from Gemini (unchanged) ...

    const batch_request_ids = [];
    const batch_embeddings = [];
    const batch_uniclass_types = [];
    
    queries.forEach((query, i) => {
        if (embeddings[i]) {
            batch_request_ids.push(query.request_id || i);
            batch_embeddings.push(JSON.stringify(embeddings[i]));
            batch_uniclass_types.push(query.uniclass_type.toUpperCase());
        }
    });

    console.log("--- Data being sent to Supabase RPC 'batch_match_uniclass' ---");
    console.log("Request IDs:", JSON.stringify(batch_request_ids));
    console.log("Uniclass Types:", JSON.stringify(batch_uniclass_types));
    console.log("First Embedding String:", batch_embeddings.length > 0 ? batch_embeddings[0] : "N/A");
    console.log("---------------------------------------------------------");

    const { data: batchData, error: batchError } = await supabase.rpc('batch_match_uniclass', {
        p_request_ids: batch_request_ids,
        p_query_embeddings: batch_embeddings,
        p_uniclass_type_filters: batch_uniclass_types
    });

    // ... rest of the function is unchanged ...
  } catch (error) {
    // ... error handling ...
  }
}

// --- FULL CODE TO COPY ---
// The above snippet was for explanation. Use this full block for the file.
import { createClient } from '@supabase/supabase-js'

async function getBatchEmbeddings(texts) {
  try {
    const modelName = 'models/text-embedding-004';
    const requestBody = {
      requests: texts.map(text => ({ model: modelName, content: { parts: [{ text: text }] } }))
    };
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${modelName}:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );
    if (!response.ok) { throw new Error(`Gemini API error: ${response.status}`); }
    const data = await response.json();
    return data.embeddings ? data.embeddings.map(emb => emb.values) : new Array(texts.length).fill(null);
  } catch (error) {
    console.error('Batch embedding function error:', error);
    return new Array(texts.length).fill(null);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { queries } = req.body;
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid queries array' });
    }

    console.log("--- Vercel Function Triggered ---");
    console.log("Raw incoming queries from Excel:", JSON.stringify(queries, null, 2));

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const queryTexts = queries.map(q => q.query);

    const CHUNK_SIZE = 100;
    const embeddingPromises = [];
    for (let i = 0; i < queryTexts.length; i += CHUNK_SIZE) {
      embeddingPromises.push(getBatchEmbeddings(queryTexts.slice(i, i + CHUNK_SIZE)));
    }
    const embeddingChunks = await Promise.all(embeddingPromises);
    const embeddings = embeddingChunks.flat();

    console.log(`Received ${embeddings.filter(e => e).length}/${queries.length} embeddings from Gemini.`);

    const batch_request_ids = [];
    const batch_embeddings = [];
    const batch_uniclass_types = [];
    
    queries.forEach((query, i) => {
        if (embeddings[i]) {
            batch_request_ids.push(query.request_id || i);
            batch_embeddings.push(JSON.stringify(embeddings[i]));
            batch_uniclass_types.push(query.uniclass_type.toUpperCase());
        }
    });

    console.log("--- Data being sent to Supabase RPC 'batch_match_uniclass' ---");
    console.log("Request IDs:", JSON.stringify(batch_request_ids));
    console.log("Uniclass Types:", JSON.stringify(batch_uniclass_types));
    console.log("First Embedding String:", batch_embeddings.length > 0 ? batch_embeddings[0] : "N/A");
    console.log("---------------------------------------------------------");

    const { data: batchData, error: batchError } = await supabase.rpc('batch_match_uniclass', {
        p_request_ids: batch_request_ids,
        p_query_embeddings: batch_embeddings,
        p_uniclass_type_filters: batch_uniclass_types
    });

    if (batchError) {
      console.error('Supabase batch function error:', batchError);
      return res.status(500).json({ error: 'Database batch processing failed' });
    }

    const resultsMap = new Map();
    batchData.forEach(item => {
        let result_text;
        const output_format = queries[item.request_id]?.output_format?.toUpperCase() || 'COBIE';
        switch (output_format) {
            case 'CODE': result_text = item.code; break;
            case 'TITLE': result_text = item.title; break;
            default: result_text = `${item.code}:${item.title}`;
        }
        const scoreFormatted = item.similarity.toFixed(2);
        const finalResult = `${result_text}:${scoreFormatted}`;
        resultsMap.set(Number(item.request_id), {
            request_id: Number(item.request_id), match: finalResult, confidence: item.similarity, alternatives: []
        });
    });

    const finalResults = queries.map((query, i) => {
        const requestId = query.request_id || i;
        if (resultsMap.has(requestId)) { return resultsMap.get(requestId); }
        return {
            request_id: requestId, match: embeddings[i] ? 'No match found:0.00' : 'Embedding failed:0.00', confidence: 0, alternatives: []
        };
    });

    console.log(`Batch processing complete: ${finalResults.length} results returned.`);
    return res.json({ success: true, processed: finalResults.length, results: finalResults });

  } catch (error) {
    console.error('Batch API Handler Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
