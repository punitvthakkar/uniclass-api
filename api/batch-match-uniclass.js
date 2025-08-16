import { createClient } from '@supabase/supabase-js'

// The getBatchEmbeddings function is confirmed to be working correctly. No changes needed.
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

// --- MAIN HANDLER (REWRITTEN WITH PARALLEL DATABASE QUERIES) ---
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

    console.log(`Processing batch of ${queries.length} queries.`);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const queryTexts = queries.map(q => q.query);

    // Step 1: Get all embeddings from Gemini (this part works).
    const CHUNK_SIZE = 100;
    const embeddingPromises = [];
    for (let i = 0; i < queryTexts.length; i += CHUNK_SIZE) {
      embeddingPromises.push(getBatchEmbeddings(queryTexts.slice(i, i + CHUNK_SIZE)));
    }
    const embeddingChunks = await Promise.all(embeddingPromises);
    const embeddings = embeddingChunks.flat();

    console.log(`Received ${embeddings.filter(e => e).length}/${queries.length} unique embeddings from Gemini.`);

    // Step 2: Create an array of promises, one for each database query.
    // This is the new, robust logic that replaces the faulty sequential 'for' loop.
    const supabasePromises = queries.map(async (query, i) => {
      const { uniclass_type, output_format = 'COBIE', request_id } = query;
      const queryEmbedding = embeddings[i];

      if (!queryEmbedding) {
        return { request_id: request_id || i, match: 'Embedding failed:0.00', confidence: 0, alternatives: [] };
      }

      const { data, error } = await supabase.rpc('match_uniclass', {
        query_embedding: queryEmbedding,
        uniclass_type_filter: uniclass_type.toUpperCase(),
        match_threshold: 0.1,
        match_count: 3
      });

      if (error) {
        console.error('Supabase error for request_id', request_id, ':', error);
        return { request_id: request_id || i, match: 'Database error:0.00', confidence: 0, alternatives: [] };
      }
      if (!data || data.length === 0) {
        return { request_id: request_id || i, match: 'No match found:0.00', confidence: 0, alternatives: [] };
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

      return {
        request_id: request_id || i,
        match: finalResult,
        confidence: best.similarity,
        alternatives: data.slice(1).map(item => ({ code: item.code, title: item.title, confidence: item.similarity }))
      };
    });

    // Step 3: Execute all the database queries in parallel.
    const results = await Promise.all(supabasePromises);

    // The VBA script needs the results to be in the original order. We must re-sort them.
    const sortedResults = results.sort((a, b) => a.request_id - b.request_id);

    console.log(`Batch processing complete: ${sortedResults.length} results returned.`);
    return res.json({ success: true, processed: sortedResults.length, results: sortedResults });

  } catch (error) {
    console.error('Batch API Handler Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
