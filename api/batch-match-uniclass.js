import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // Enable CORS for Excel to call this API
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  // Handle preflight requests
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

    if (queries.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 queries per batch' })
    }

    console.log(`Processing batch of ${queries.length} queries`)

    // Initialize Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    // Extract all query texts for batch embedding
    const queryTexts = queries.map(q => q.query)
    console.log(`Extracted ${queryTexts.length} texts for batch embedding`)

    // Get batch embeddings from Gemini (matching your Python approach)
    const embeddings = await getBatchEmbeddings(queryTexts)
    if (!embeddings || embeddings.length !== queryTexts.length) {
      return res.status(500).json({ error: 'Failed to get batch embeddings' })
    }

    console.log(`Got ${embeddings.length} embeddings from Gemini`)

    // Process each query with its corresponding embedding
    const results = []
    
    for (let i = 0; i < queries.length; i++) {
      const { query, uniclass_type, output_format = 'COBIE', request_id } = queries[i]
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

        // Search for similar vectors in Supabase
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
        
        // Format the base result without score
        switch (output_format.toUpperCase()) {
          case 'CODE':
            result_text = best.code
            break
          case 'TITLE':
            result_text = best.title
            break
          default: // 'COBIE'
            result_text = `${best.code}:${best.title}`
        }
        
        // Always append score with 2 decimal places
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

// Batch embedding function (matching your Python approach)
// Batch embedding function (using correct Gemini REST API format)
// Batch embedding function (trying with "contents" plural)
async function getBatchEmbeddings(texts) {
  try {
    console.log(`Getting batch embeddings for ${texts.length} texts`)
    
    // Try with "contents" (plural) like the JavaScript SDK
    const requestBody = {
      model: 'models/text-embedding-004',
      contents: texts.map(text => ({
        parts: [{ text: text }]
      }))
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    console.log(`Gemini API response received, checking format...`)
    
    // The response should contain embeddings array
    if (data.embeddings && Array.isArray(data.embeddings)) {
      console.log(`Successfully got ${data.embeddings.length} embeddings`)
      return data.embeddings.map(emb => emb.values)
    } else {
      console.log('Response format:', Object.keys(data))
      throw new Error('Unexpected response format from Gemini API')
    }
    
  } catch (error) {
    console.error('Batch embedding error:', error)
    return null
  }
}
