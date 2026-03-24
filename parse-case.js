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

CRITICAL CODING RULES — follow these exactly:

CAPSULECTOMY vs CAPSULOTOMY:
- If complete removal of capsule mentioned → include BOTH 19370 AND 19371 (let resident pick)
- If only capsulotomy/release mentioned → 19370 only
- If clearly total/complete capsulectomy → 19371 only
- Capsulorrhaphy has no standalone CPT — bundle with 19371 or 19380

IMPLANT REMOVAL + REPLACEMENT (exchange):
- Always include 19328 (removal of intact implant) when implant is being removed
- When NEW implant is placed in same or later surgery → include 19340 (immediate) or 19342 (delayed)
- NEVER suggest 19325 for implant exchange — 19325 is primary augmentation in a virgin breast only
- For full implant exchange: suggest 19328 + 19342 together

AUGMENTATION:
- 19325 = primary cosmetic aug, no prior surgery, no prosthetic — ONLY for first-time aug patients
- 19340 = immediate implant after mastectomy
- 19342 = delayed implant / revision / exchange after prior surgery

BREAST REDUCTION vs MASTOPEXY:
- Reduction with significant tissue removal → 19318
- Lift only, minimal tissue removal → 19316
- If both described → include both

RHINOPLASTY:
- Primary with tip only → 30400
- Primary complete with osteotomies → 30410
- Primary with major septal work → 30420
- Secondary minor → 30430, major → 30450
- If unspecified primary → include 30400 AND 30410 for selection

FACELIFT:
- Full face, cheek, neck → 15828
- Neck only → 15825
- Forehead/brow only → 15824
- If unspecified → include 15828

ABDOMINOPLASTY:
- Full tummy tuck with muscle repair → 15847
- Skin excision only/panniculectomy → 15830
- If ambiguous → include both for selection

General rules:
- Suggest 1-5 codes, most relevant first
- When a case clearly involves multiple distinct procedures, include all of them
- When a description is ambiguous between two similar codes, include BOTH so resident can choose
- Only suggest codes that exist in the ACGME Plastic Surgery tracked codes list
- If attending mentioned by last name, match to available attendings
- Keep notes brief

CRITICAL: Only suggest CPT codes that actually exist in the ACGME Plastic Surgery tracked list. Never invent or guess codes. If unsure of the exact code number, omit it rather than guess. The following are the ONLY valid breast codes you may suggest: 19316, 19318, 19325, 19328, 19330, 19340, 19342, 19350, 19357, 19361, 19364, 19367, 19368, 19369, 19370, 19371, 19380. Never suggest 19324 — it does not exist.

Return ONLY valid JSON, no markdown:
{
  "role": "Surgeon" | "Assistant" | "Teaching Assistant" | "Observer",
  "patientType": "Adult" | "Pediatric",
  "caseYear": 1-6,
  "attending": "Dr. Smith" | "Dr. Johnson" | "Dr. Williams" | "Dr. Brown" | null,
  "site": "Larkin Community Hospital" | "Larkin Palm Springs" | "Affiliated Site" | null,
  "notes": "brief clinical notes",
  "suggestedCodes": [
    {
      "code": "5-digit CPT code",
      "desc": "official CPT description",
      "area": "ACGME category area",
      "confidence": "high" | "medium"
    }
  ]
}`,

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
