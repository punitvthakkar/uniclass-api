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
    const { query, uniclass_type, output_format = 'COBIE' } = req.body
    
    if (!query || !uniclass_type) {
      return res.status(400).json({ error: 'Missing query or uniclass_type' })
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    // Get query embedding from Gemini
    const queryEmbedding = await getEmbedding(query)
    if (!queryEmbedding) {
      return res.status(500).json({ error: 'Failed to get embedding' })
    }

    // Search for similar vectors in Supabase
    const { data, error } = await supabase.rpc('match_uniclass', {
      query_embedding: queryEmbedding,
      uniclass_type_filter: uniclass_type.toUpperCase(),
      match_threshold: 0.1,
      match_count: 3
    })

    if (error) {
      console.error('Supabase error:', error)
      return res.status(500).json({ error: 'Database search failed' })
    }

    if (!data || data.length === 0) {
      return res.json({
        match: 'No match found:0.00',
        confidence: 0,
        alternatives: []
      })
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

    res.json({
      match: finalResult,
      confidence: best.similarity,
      alternatives: data.slice(1).map(item => ({
        code: item.code,
        title: item.title,
        confidence: item.similarity
      }))
    })

  } catch (error) {
    console.error('API Error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

async function getEmbedding(text) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text }] }
        })
      }
    )

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`)
    }

    const data = await response.json()
    return data.embedding?.values || null
    
  } catch (error) {
    console.error('Embedding error:', error)
    return null
  }
}
