// api/code-lookup.js
// Educational CPT / ICD-10-CM lookup — Claude Haiku (low cost, fast)
// V1: model-led lookup with heuristic system detection

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CPT_DISCLAIMER =
  'Educational lookup only. Verify the final code against your coding workflow, payer rules, and licensed references before billing or compliance use.';
const ICD_DISCLAIMER =
  'Educational lookup only. Verify final diagnosis coding against official ICD-10-CM guidance and your clinical documentation before billing or compliance use.';

// Heuristic system detection — model refines this
function detectSystem(query, requested) {
  if (requested === 'cpt') return 'cpt';
  if (requested === 'icd10') return 'icd10';

  const q = query.toLowerCase();
  const icdSignals = [
    /\bicd\b/, /\bdiagnosis\b/, /\bdiagnoses\b/, /\bdx\b/, /\bcondition\b/,
    /\bdisorder\b/, /\bdisease\b/, /\bsyndrome\b/, /\bdeformity\b/,
    /^[a-zA-Z]\d{2}\.?\d{0,4}$/, // ICD-10 code pattern like N65.0
  ];
  const cptSignals = [
    /\bcpt\b/, /\bprocedure\b/, /\bsurgery\b/, /\brepair\b/, /\bexcision\b/,
    /\breconstruct\b/, /\bgraft\b/, /\bplasty\b/, /\btomy\b/, /\bectomy\b/,
    /^\d{5}$/, // 5-digit CPT code
  ];

  const icdScore = icdSignals.filter(r => r.test(q)).length;
  const cptScore = cptSignals.filter(r => r.test(q)).length;

  if (icdScore > cptScore) return 'icd10';
  if (cptScore > icdScore) return 'cpt';
  return 'auto'; // let model decide
}

function buildPrompt(query, system) {
  const systemHint = system === 'auto'
    ? 'Determine whether this is a CPT (procedure) or ICD-10-CM (diagnosis) query. If clearly both or ambiguous, pick the more likely one and note it.'
    : system === 'cpt'
    ? 'The user is asking about CPT procedure codes.'
    : 'The user is asking about ICD-10-CM diagnosis codes.';

  return `You are a medical coding educational assistant. ${systemHint}

User query: "${query}"

Return a JSON object with this exact shape:
{
  "normalizedQuery": "clean version of user query",
  "system": "cpt" or "icd10",
  "results": [
    {
      "code": "XXXXX",
      "paraphrase": "plain English description (not verbatim official descriptor)",
      "confidence": "high" | "medium" | "low",
      "rationale": "1 short sentence why this matches"
    }
  ],
  "needsClarification": false,
  "clarificationNote": "optional — only if query is genuinely ambiguous"
}

Rules:
- Return up to 5 results ranked best-first
- For CPT: paraphrase in plain English, never copy long official descriptor text verbatim
- For ICD-10: use standard code + concise plain-English description
- If ambiguous, return multiple likely codes with rationale for each
- If weak match, use confidence: "low" and say so in rationale — do not hallucinate certainty
- If no reasonable match, return an empty results array and set needsClarification: true
- Output ONLY valid JSON, no markdown, no prose`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const query = (body?.query || '').trim();
  const requested = (body?.system || 'auto').toLowerCase();

  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > 300) return res.status(400).json({ error: 'query too long' });
  if (!['auto', 'cpt', 'icd10'].includes(requested)) {
    return res.status(400).json({ error: 'system must be auto, cpt, or icd10' });
  }

  const detectedSystem = detectSystem(query, requested);
  const prompt = buildPrompt(query, detectedSystem);

  let parsed;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '';
    // Strip any accidental markdown code fences
    const json = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(json);
  } catch (e) {
    console.error('code-lookup model error:', e);
    return res.status(502).json({ error: 'Lookup failed. Try rephrasing your query.' });
  }

  // Validate shape
  if (!parsed.results || !Array.isArray(parsed.results)) {
    return res.status(502).json({ error: 'Unexpected response format from model.' });
  }

  const resolvedSystem = parsed.system || detectedSystem;

  return res.status(200).json({
    system: resolvedSystem,
    normalizedQuery: parsed.normalizedQuery || query,
    results: parsed.results.slice(0, 5),
    needsClarification: parsed.needsClarification || false,
    clarificationNote: parsed.clarificationNote || null,
    disclaimer: resolvedSystem === 'icd10' ? ICD_DISCLAIMER : CPT_DISCLAIMER,
  });
}
