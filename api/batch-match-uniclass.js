

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // Enable CORS for Excel to call this API
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { queries } = req.body
    
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid queries array' })
    }
    
    // We can increase this limit now as our function can handle more
    if (queries.length > 2000) {
      return res.status(400).json({ error: 'Maximum 2000 queries per batch' })
    }

    console.log(`Processing batch of ${queries.length} queries`)

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    const queryTexts = queries.map(q => q.query)

    // --- START OF MODIFIED LOGIC ---
    // This section now handles chunking the requests to Gemini
    
    const CHUNK_SIZE = 100; // Gemini API limit
    const embeddingPromises = [];
    
    console.log(`Splitting ${queryTexts.length} texts into chunks of ${CHUNK_SIZE}`);

    for (let i = 0; i < queryTexts.length; i += CHUNK_SIZE) {
      const chunk = queryTexts.slice(i, i + CHUNK_SIZE);
      // Add the promise for each chunk to an array
      embeddingPromises.push(getBatchEmbeddings(chunk));
    }
    
    // Await all promises to resolve in parallel
    const embeddingChunks = await Promise.all(embeddingPromises);
    
    // Flatten the array of arrays into a single array of embeddings
    const embeddings = embeddingChunks.flat();

    // --- END OF MODIFIED LOGIC ---

    if (!embeddings || embeddings.length !== queryTexts.length) {
      console.error('Failed to get batch embeddings or count mismatch after chunking.');
      return res.status(500).json({ error: 'Failed to get batch embeddings' })
    }

    console.log(`Got ${embeddings.length} embeddings from Gemini`)

    const results = []
    
    for (let i = 0; i < queries.length; i++) {
      const { uniclass_type, output_format = 'COBIE', request_id } = queries[i]
      const queryEmbedding = embeddings[i]
      
      try {
        if (!queryEmbedding) {
          results.push({
            request_id: request_id || i,
            match: 'Embedding failed:0.00',
            confidence: 0,
            alternatives: []
          })
          continue
        }

        const { data, error } = await supabase.rpc('match_uniclass', {
          query_embedding: queryEmbedding,
          uniclass_type_filter: uniclass_type.toUpperCase(),
          match_threshold: 0.1,
          match_count: 3
        })

        if (error) {
          console.error('Supabase error for query', i, ':', error)
          results.push({
            request_id: request_id || i,
            match: 'Database error:0.00',
            confidence: 0,
            alternatives: []
          })
          continue
        }

        if (!data || data.length === 0) {
          results.push({
            request_id: request_id || i,
            match: 'No match found:0.00',
            confidence: 0,
            alternatives: []
          })
          continue
        }

        const best = data[0]
        let result_text
        
        switch (output_format.toUpperCase()) {
          case 'CODE':
            result_text = best.code
            break
          case 'TITLE':
            result_text = best.title
            break
          default:
            result_text = `${best.code}:${best.title}`
        }
        
        const scoreFormatted = best.similarity.toFixed(2)
        const finalResult = `${result_text}:${scoreFormatted}`

        results.push({
          request_id: request_id || i,
          match: finalResult,
          confidence: best.similarity,
          alternatives: data.slice(1).map(item => ({
            code: item.code,
            title: item.title,
            confidence: item.similarity
          }))
        })

      } catch (error) {
        console.error('Error processing query', i, ':', error)
        results.push({
          request_id: request_id || i,
          match: 'Processing error:0.00',
          confidence: 0,
          alternatives: []
        })
      }
    }

    console.log(`Batch processing complete: ${results.length} results`)

    res.json({
      success: true,
      processed: results.length,
      results: results
    })

  } catch (error) {
    console.error('Batch API Error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}


async function getBatchEmbeddings(texts) {
  // This function is now perfect, it handles one valid-sized chunk at a time. No changes needed here.
  try {
    console.log(`Getting batch embeddings for a chunk of ${texts.length} texts.`);
    
    const requestBody = {
      requests: texts.map(text => ({
        model: 'models/text-embedding-004',
        content: {
          parts: [{ text: text }]
        }
      }))
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`,
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
    // Return an array of nulls of the same length to prevent crashing the main loop
    return new Array(texts.length).fill(null);
  }
}
