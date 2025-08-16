import { createClient } from '@supabase/supabase-js'

// Helper function to get batch embeddings from the Gemini API.
// It chunks requests to stay within API limits if necessary.
async function getBatchEmbeddings(texts) {
  try {
    const modelName = 'models/text-embedding-004';
    // Construct the request body with all texts.
    const requestBody = {
      requests: texts.map(text => ({
        model: modelName,
        content: { parts: [{ text: text }] }
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
      console.error('Gemini API Error Response:', await response.text());
      throw new Error(`Gemini API error: ${response.status}`);
    }
    const data = await response.json();
    // Return an array of embedding vectors, or null for any failures.
    return data.embeddings ? data.embeddings.map(emb => emb.values) : new Array(texts.length).fill(null);
  } catch (error) {
    console.error('Batch embedding function error:', error);
    // Return an array of nulls so the process can continue and report errors.
    return new Array(texts.length).fill(null);
  }
}

// Main API handler function
export default async function handler(req, res) {
  // Standard CORS headers to allow requests from Excel/anywhere.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle the browser's preflight request.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  // Ensure the request method is POST.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { queries } = req.body;
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid queries array' });
    }

    // Initialize the Supabase client.
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    
    // Extract just the text from the query objects for the Gemini API call.
    const queryTexts = queries.map(q => q.query);
    
    // Get all embeddings in a single batch call.
    const embeddings = await getBatchEmbeddings(queryTexts);

    // Prepare the three parallel arrays for the Supabase RPC call.
    const batch_request_ids = [];
    const batch_embeddings = [];
    const batch_uniclass_types = [];
    
    queries.forEach((query, i) => {
        // Only process queries that successfully received an embedding.
        if (embeddings[i]) {
            // THE FIX: Explicitly convert the request_id from a string to a number.
            // This is critical to match the `bigint[]` type in the SQL function.
            batch_request_ids.push(Number(query.request_id));

            // Convert the vector array to a JSON string for transport in the text array.
            batch_embeddings.push(JSON.stringify(embeddings[i]));
            batch_uniclass_types.push(query.uniclass_type.toUpperCase());
        }
    });

    // If there are any valid embeddings, call the Supabase function.
    let batchData = [];
    if (batch_request_ids.length > 0) {
        const { data, error } = await supabase.rpc('batch_match_uniclass', {
            p_request_ids: batch_request_ids,
            p_query_embeddings: batch_embeddings,
            p_uniclass_type_filters: batch_uniclass_types
        });

        if (error) {
          console.error('Supabase batch function error:', error);
          return res.status(500).json({ error: 'Database batch processing failed' });
        }
        batchData = data;
    }

    // Map the results from Supabase back to their original request IDs for correct ordering.
    const resultsMap = new Map();
    batchData.forEach(item => {
        const output_format = queries[item.request_id]?.output_format?.toUpperCase() || 'COBIE';
        let result_text;
        switch (output_format) {
            case 'CODE': result_text = item.code; break;
            case 'TITLE': result_text = item.title; break;
            default: result_text = `${item.code}:${item.title}`;
        }
        const scoreFormatted = item.similarity.toFixed(2);
        const finalResult = `${result_text}:${scoreFormatted}`;
        // Use the numeric request_id as the key.
        resultsMap.set(Number(item.request_id), {
            request_id: Number(item.request_id),
            match: finalResult
        });
    });

    // Construct the final results array, preserving the original order.
    // If a query wasn't in the resultsMap, provide a meaningful error.
    const finalResults = queries.map((query, i) => {
        const requestId = Number(query.request_id);
        if (resultsMap.has(requestId)) {
            return resultsMap.get(requestId);
        }
        // Provide a specific reason for failure.
        const match_text = embeddings[i] ? 'No match found:0.00' : 'Embedding failed:0.00';
        return {
            request_id: requestId,
            match: match_text
        };
    });

    return res.json({ success: true, results: finalResults });

  } catch (error) {
    console.error('Batch API Handler Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
