// api/parse-case.js
// Vercel serverless function — drop this in your /api folder
// Set ANTHROPIC_API_KEY in your Vercel project environment variables

export default async function handler(req, res) {
  // CORS — allow your Vercel frontend domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are an expert medical coding assistant for a Plastic Surgery - Integrated residency program using the ACGME case log system.

Your job is to extract structured case data from a resident's spoken case description and suggest the most accurate CPT codes.

The resident is at Larkin Community Hospital / Larkin Palm Springs in Hialeah, FL.
Available attendings: Dr. Smith, Dr. Johnson, Dr. Williams, Dr. Brown.
Available sites: Larkin Community Hospital, Larkin Palm Springs, Affiliated Site.

Return ONLY valid JSON with this exact structure — no extra text, no markdown:
{
  "role": "Surgeon" | "Assistant" | "Teaching Assistant" | "Observer",
  "patientType": "Adult" | "Pediatric",
  "caseYear": 1-6,
  "attending": "Dr. Smith" | "Dr. Johnson" | "Dr. Williams" | "Dr. Brown" | null,
  "site": "Larkin Community Hospital" | "Larkin Palm Springs" | "Affiliated Site" | null,
  "notes": "any clinical notes worth capturing",
  "suggestedCodes": [
    {
      "code": "5-digit CPT code",
      "desc": "official CPT description",
      "area": "ACGME category area",
      "confidence": "high" | "medium"
    }
  ]
}

Rules:
- Suggest 1-4 CPT codes, most relevant first
- Only suggest codes that exist in the ACGME Plastic Surgery tracked codes list
- If role is ambiguous, default to Surgeon
- If attending is mentioned by last name only, match to the closest available attending
- If site is mentioned or inferable, fill it in
- Keep notes brief — only clinically relevant details
- caseYear should be inferred from context (e.g. "PGY4" = 4) or default to 4`,

        messages: [
          {
            role: 'user',
            content: `Extract case details from this description: "${transcript}"`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const rawText = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Parse error:', err);
    return res.status(500).json({ error: 'Failed to parse case', detail: err.message });
  }
}
