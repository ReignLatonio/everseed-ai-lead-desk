// Vercel serverless function: /api/ai
// Keeps the AI API key on the server. The browser never sees it.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   ANTHROPIC_API_KEY  (option A) Claude API key from console.anthropic.com
//   ANTHROPIC_MODEL    optional, default "claude-haiku-5-5"
//   GROQ_API_KEY       (option C, FREE, no card) key from console.groq.com
//   GROQ_MODEL         optional, default "llama-3.3-70b-versatile" (falls back to other Groq models)
//   GEMINI_API_KEY     (option B) Google Gemini key from aistudio.google.com (has a free tier)
//   GEMINI_MODEL       optional, one model or a comma-separated list (default "gemini-3.8-flash");
//                      if busy, other Flash models on the account are tried automatically
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

// Models found on the key's account, cached per server instance
let modelCache = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listFlashModels(key) {
  if (modelCache) return modelCache;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
    });
    if (!r.ok) return [];
    const j = await r.json();
    modelCache = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /flash/i.test(n) && !/(image|tts|audio|live|embed|preview-tts)/i.test(n))
      .sort((x, y) => y.localeCompare(x, undefined, { numeric: true })); // newest first
    return modelCache;
  } catch {
    return [];
  }
}

async function callGemini(url, key, model, prompt) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
        ...(model.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY.trim();
  // GEMINI_MODEL may be one model or a comma-separated list, tried in order
  const preferred = (process.env.GEMINI_MODEL || "gemini-3.8-flash").split(",").map((m) => m.trim()).filter(Boolean);
  const tried = new Set();
  let candidates = [...preferred];
  let lastErr = "";
  let attempts = 0;
  const started = Date.now();

  while (candidates.length && attempts < 6 && Date.now() - started < 8000) {
    const model = candidates.shift();
    if (tried.has(model)) continue;
    tried.add(model);
    attempts++;
    const studio = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const vertex = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`;
    const urls = key.startsWith("AQ.") ? [studio, vertex] : [studio];

    for (const url of urls) {
      let r = await callGemini(url, key, model, prompt);
      if (r.status === 503 || r.status === 429) {
        await sleep(700); // one quick retry on the same model when Google is busy
        r = await callGemini(url, key, model, prompt);
      }
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        if (text) return text;
        lastErr = `Gemini ${model} returned no text (finishReason: ${j.candidates?.[0]?.finishReason || "unknown"})`;
        break;
      }
      lastErr = `Gemini ${r.status} on ${model}: ` + (await r.text()).slice(0, 250);
      if (r.status === 503 || r.status === 429 || r.status === 404) break; // move on to another model
    }
    // Busy or missing model: add other Flash models this key can use
    if (!candidates.length) {
      const more = (await listFlashModels(key)).filter((m) => !tried.has(m));
      candidates.push(...more);
    }
  }
  throw new Error(lastErr || "No Gemini model answered");
}

// ---------- Groq (free tier, OpenAI-compatible) ----------
let groqModels = null;
async function listGroqModels(key) {
  if (groqModels) return groqModels;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: "Bearer " + key } });
    if (!r.ok) return [];
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter((id) => !/(whisper|tts|guard|playai|orpheus|compound|safeguard)/i.test(id));
    const rank = (id) => (/llama-3\.3-70b/i.test(id) ? 0 : /gpt-oss-120b/i.test(id) ? 1 : /llama-4/i.test(id) ? 2 : /qwen/i.test(id) ? 3 : /gpt-oss/i.test(id) ? 4 : 5);
    groqModels = ids.sort((a, b) => rank(a) - rank(b));
    return groqModels;
  } catch {
    return [];
  }
}

async function askGroq(prompt) {
  const key = process.env.GROQ_API_KEY.trim();
  const preferred = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").split(",").map((m) => m.trim()).filter(Boolean);
  const tried = new Set();
  const candidates = [...preferred];
  let lastErr = "";
  const started = Date.now();
  while (candidates.length && tried.size < 5 && Date.now() - started < 8000) {
    const model = candidates.shift();
    if (tried.has(model)) continue;
    tried.add(model);
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1500, temperature: 0.7 }),
    });
    if (r.ok) {
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content || "";
      if (text) return text;
      lastErr = `Groq ${model} returned no text`;
    } else {
      lastErr = `Groq ${r.status} on ${model}: ` + (await r.text()).slice(0, 250);
      if (r.status === 401) break; // bad key: no point trying other models
    }
    if (!candidates.length) candidates.push(...(await listGroqModels(key)).filter((m) => !tried.has(m)));
  }
  throw new Error(lastErr || "No Groq model answered");
}

export default async function handler(req, res) {
  // Every provider that has a key, tried in this order until one answers
  const providers = [
    process.env.ANTHROPIC_API_KEY && ["claude", askClaude],
    process.env.GROQ_API_KEY && ["groq", askGroq],
    process.env.GEMINI_API_KEY && ["gemini", askGemini],
  ].filter(Boolean);
  const provider = providers.map((p) => p[0]).join("+") || null;

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

  const errors = [];
  for (const [name, ask] of providers) {
    try {
      const text = await ask(prompt);
      return res.status(200).json({ text, provider: name });
    } catch (e) {
      console.error(e);
      errors.push(String(e.message || e).slice(0, 300));
    }
  }
  // Show the providers' reasons (they never contain the API key) so problems are easy to fix
  return res.status(502).json({ error: "AI request failed", detail: errors.join(" | ").slice(0, 600) });
}
