// Vercel serverless function: /api/ai
// Keeps the AI API key on the server. The browser never sees it.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   ANTHROPIC_API_KEY  (option A) Claude API key from console.anthropic.com
//   ANTHROPIC_MODEL    optional, default "claude-haiku-5-5"
//   GEMINI_API_KEY     (option B) Google Gemini key from aistudio.google.com (has a free tier)
//   GEMINI_MODEL       optional, default "gemini-2.5-flash"
//   ACCESS_CODE        optional. If set, the AI only answers people who enter this code.

const MAX_PROMPT_CHARS = 12000;
const hits = new Map(); // simple per-instance rate limit: 20 calls per IP per 10 minutes

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

async function askClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

async function askGemini(prompt) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const key = process.env.GEMINI_API_KEY.trim();
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1200, temperature: 0.7 },
  });
  // Google AI Studio keys usually start with "AIza"; Vertex AI (express mode) keys start with "AQ."
  const studio = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const vertex = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`;
  const order = key.startsWith("AQ.") ? [vertex, studio] : [studio, vertex];
  let lastErr = "";
  for (const url of order) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body,
    });
    if (r.ok) {
      const j = await r.json();
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    }
    lastErr = "Gemini " + r.status + " at " + url + ": " + (await r.text()).slice(0, 300);
    if (![400, 401, 403, 404].includes(r.status)) break; // only try the other endpoint on auth or route errors
  }
  throw new Error(lastErr);
}

export default async function handler(req, res) {
  const provider = process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GEMINI_API_KEY ? "gemini" : null;

  // Health check used by the page to switch AI buttons on or off
  if (req.method === "GET") {
    return res.status(200).json({ ok: !!provider, provider, locked: !!process.env.ACCESS_CODE });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!provider) return res.status(503).json({ error: "No AI key configured" });

  if (process.env.ACCESS_CODE && req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "Access code required" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests, try again in a few minutes" });

  const prompt = String((req.body && req.body.prompt) || "").slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const text = provider === "claude" ? await askClaude(prompt) : await askGemini(prompt);
    return res.status(200).json({ text });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "AI request failed" });
  }
}
