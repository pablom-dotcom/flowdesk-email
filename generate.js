/**
 * FlowDesk Email Sequence AI — serverless function
 * 5-question intake → Claude Haiku → JSON email sequence (3-7 emails)
 */

// Simple per-IP rate limiter (resets on cold start)
const _rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now(), window = 60000, limit = 20;
  const e = _rateMap.get(ip) || { n: 0, reset: now + window };
  if (now > e.reset) { e.n = 0; e.reset = now + window; }
  e.n++; _rateMap.set(ip, e);
  return e.n > limit;
}

const SYSTEM_PROMPT = `You are an expert email copywriter who creates high-converting, warm, non-spammy email sequences for freelancers, consultants, and small business owners. Given five short answers describing their goal, audience, and offer, you produce exactly one JSON object (no prose, no markdown fences) with this shape:

{
  "sequence_name": "string, short descriptive name for this sequence, e.g. 'Welcome + Onboarding' or 'Post-Proposal Follow-Up'",
  "emails": [
    {
      "number": 1,
      "send_day": "string, e.g. 'Day 1' or 'Immediately'",
      "subject": "string, compelling subject line under 60 chars",
      "preview": "string, preview/preheader text under 90 chars",
      "body": "string, full email body — warm, conversational, 80-200 words, plain text paragraphs separated by \\n\\n, ends with a clear CTA"
    }
  ]
}

Rules:
- Return valid JSON only — no commentary, no markdown fences.
- Generate between 3 and 7 emails depending on the sequence type and goal (welcome sequences = 3-5, nurture/sales = 5-7).
- Space emails logically: Day 1, Day 3, Day 7, Day 14, etc. — not every day unless it's an onboarding sequence.
- Write in first person as the sender. Keep tone warm, human, never pushy or salesy.
- Each email must have ONE clear call to action. No multiple CTAs.
- Never invent specific numbers, results, or testimonials not provided by the user.
- Subject lines must be specific and curiosity-driving — never generic like "Following up" or "Quick question".
- Body text uses \\n\\n for paragraph breaks. No HTML. No bullet points inside the body.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(clientIp)) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please wait a minute.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'ANTHROPIC_API_KEY is not set. Add it in your Vercel environment variables and redeploy.'
    });
  }

  let answers = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    answers = Array.isArray(body && body.answers) ? body.answers : [];
    answers = answers.map(a => (a || '').toString().trim().slice(0, 500)).slice(0, 5);
  } catch (e) {
    return res.status(400).json({ error: 'bad_request' });
  }
  if (!answers[0]) return res.status(400).json({ error: 'missing_answers' });

  const labels = [
    'Goal of this email sequence (e.g. onboard new clients, follow up after a proposal, nurture cold leads)',
    'Target audience — who will receive these emails',
    'Your offer or service being promoted',
    'Tone and style (e.g. professional, casual, friendly, authoritative)',
    'Any specific CTA or action you want readers to take'
  ];
  const briefing = labels.map((l, i) => `${i + 1}. ${l}: ${answers[i] || '(not provided)'}`).join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Here is the user's intake:\n\n${briefing}\n\nReturn the JSON object now.` }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'upstream_error', message: errText.slice(0, 300) });
    }

    const data = await response.json();
    const raw = (data.content && data.content[0] && data.content[0].text) || '';

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'parse_error', message: 'Model did not return valid JSON.' });
    }

    if (!Array.isArray(parsed.emails)) {
      return res.status(502).json({ error: 'shape_error' });
    }

    const emails = parsed.emails.slice(0, 7).map((e, i) => ({
      number: Number(e.number || i + 1),
      send_day: String(e.send_day || `Day ${i + 1}`).slice(0, 30),
      subject: String(e.subject || '').slice(0, 100),
      preview: String(e.preview || '').slice(0, 150),
      body: String(e.body || '').slice(0, 1500)
    }));

    return res.status(200).json({
      sequence_name: String(parsed.sequence_name || 'Email Sequence').slice(0, 80),
      emails
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
