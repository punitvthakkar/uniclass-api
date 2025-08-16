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

    // Extract unique text queries for batch embedding
    const uniqueTexts = [...new Set(queries.map(q => q.query))]
    console.log(`${uniqueTexts.length} unique texts to embed`)

    // Get batch embeddings from Gemini
    const embeddings = await getBatchEmbeddings(uniqueTexts)
    if (!embeddings) {
      return res.status(500).json({ error: 'Failed to get batch embeddings' })
    }

    // Create mapping from text to embedding
    const textToEmbedding = {}
    uniqueTexts.forEach((text, index) => {
      textToEmbedding[text] = embeddings[index]
    })

    // Process each query
    const results = []
    
    for (let i = 0; i < queries.length; i++) {
      const { query, uniclass_type, output_format = 'COBIE', request_id } = queries[i]
      
      try {
        const queryEmbedding = textToEmbedding[query]
        
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

async function getBatchEmbeddings(texts) {
  try {
    // Prepare batch request for Gemini
    const requests = texts.map(text => ({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] }
    }))

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      }
    )

    if (!response.ok) {
      throw new Error(`Gemini Batch API error: ${response.status}`)
    }

    const data = await response.json()
    
    if (!data.embeddings) {
      throw new Error('No embeddings in response')
    }

    return data.embeddings.map(item => item.values)
    
  } catch (error) {
    console.error('Batch embedding error:', error)
    return null
  }
}
