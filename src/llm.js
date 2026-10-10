// Дешёвый маршрутизатор LLM для простых задач (классификация, разбор текста в JSON).
// Сначала бесплатный Groq (быстрая/умная модель), при лимите — вторая модель Groq,
// и только потом Claude без инструментов (runOneShot). Основное мышление Джарвиса сюда не идёт.
// Лимиты Groq не зашиты в код: смотрим заголовки x-ratelimit-* и retry-after,
// а при 429 держим модель «на паузе» в памяти до сброса.
import { config } from "./config.js";
import { runOneShot } from "./claudeClient.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TIMEOUT_MS = 20_000;
const MAX_COOL_SEC = 24 * 3600;

let fetchImpl = (...a) => fetch(...a);
let claudeImpl = (args) => runOneShot(args);
let override = null;

// Тесты: подмена всего cheapLLM / транспорта (без сети и без Claude).
export function setCheapLLM(fn) {
  override = fn || null;
}
export function setLLMTransport({ fetch: f, claude: c } = {}) {
  fetchImpl = f || ((...a) => fetch(...a));
  claudeImpl = c || ((args) => runOneShot(args));
}

const tashkentDay = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const stats = { date: tashkentDay(), requests: {}, failures: {}, byPurpose: {} };
const cooling = new Map(); // model -> epoch ms, до которого пауза
const limits = {}; // model -> последние заголовки лимитов

function rollDay() {
  if (stats.date === tashkentDay()) return;
  stats.date = tashkentDay();
  stats.requests = {};
  stats.failures = {};
  stats.byPurpose = {};
}
function count(kind, key) {
  rollDay();
  stats[kind][key] = (stats[kind][key] || 0) + 1;
}

// "2m59.56s" | "7.66s" | "120ms" | "30" -> секунды (или null)
export function parseDurationSec(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    found = true;
    total += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  }
  return found ? total : null;
}

function noteHeaders(model, headers) {
  const h = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k]) ?? null;
  const remReq = h("x-ratelimit-remaining-requests");
  const remTok = h("x-ratelimit-remaining-tokens");
  const resetReq = parseDurationSec(h("x-ratelimit-reset-requests"));
  const resetTok = parseDurationSec(h("x-ratelimit-reset-tokens"));
  limits[model] = { remainingRequests: remReq === null ? null : Number(remReq), remainingTokens: remTok === null ? null : Number(remTok), resetRequests: resetReq, resetTokens: resetTok, at: Date.now() };
  return { remReq: limits[model].remainingRequests, remTok: limits[model].remainingTokens, resetReq, resetTok, retryAfter: parseDurationSec(h("retry-after")) };
}

function coolFor(model, sec) {
  const s = Math.min(Math.max(sec || 60, 1), MAX_COOL_SEC);
  cooling.set(model, Date.now() + s * 1000);
}
const isCooling = (model) => (cooling.get(model) || 0) > Date.now();

// Достали JSON из ответа модели (допускаем ```json и текст вокруг).
export function parseJsonLoose(raw) {
  const t = String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : null;
  } catch {}
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  return null;
}

async function groqCall(model, system, user, json, maxTokens) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const sys = json && !/json/i.test(system) ? `${system}\nОтветь только JSON.` : system;
    const res = await fetchImpl(GROQ_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    const lim = noteHeaders(model, res.headers);
    if (res.status === 429) {
      coolFor(model, lim.retryAfter ?? lim.resetReq ?? lim.resetTok ?? 60);
      const err = new Error("HTTP 429 (лимит Groq)");
      err.status = 429;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // Запас на исходе — заранее ставим паузу до сброса, не дожидаясь 429.
    if (lim.remReq === 0) coolFor(model, lim.resetReq ?? 60);
    else if (lim.remTok !== null && lim.remTok < 100) coolFor(model, lim.resetTok ?? 30);
    return String(data.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    if (err.name === "AbortError") throw new Error("таймаут 20 с");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// -> { text, json, provider: "groq:<model>" | "claude" }; бросает ошибку, если все провайдеры отказали.
// fallback: "claude" (по умолчанию) | "none" — не тратить Claude (например, классификатор каждого сообщения).
export async function cheapLLM(opts) {
  if (override) return override(opts);
  const { purpose = "misc", system, user, json = true, quality = "fast", maxTokens, fallback = "claude" } = opts;
  count("byPurpose", purpose);
  const fast = config.groqFastModel;
  const smart = config.groqSmartModel;
  const order = [...new Set(quality === "smart" ? [smart, fast] : [fast, smart])];
  const errors = [];
  if (config.groqApiKey) {
    for (const model of order) {
      if (isCooling(model)) {
        errors.push(`${model}: на паузе`);
        continue;
      }
      try {
        count("requests", `groq:${model}`);
        const text = await groqCall(model, system, user, json, maxTokens);
        const parsed = json ? parseJsonLoose(text) : null;
        if (json && !parsed) throw new Error("ответ не JSON");
        return { text, json: parsed, provider: `groq:${model}` };
      } catch (err) {
        count("failures", `groq:${model}`);
        errors.push(`${model}: ${err.message}`);
      }
    }
  } else errors.push("нет GROQ_API_KEY");
  if (fallback === "none") throw new Error(`LLM недоступен (${errors.join("; ")})`);
  try {
    count("requests", "claude");
    const sys = json ? `${system}\n\nОтветь только валидным JSON, без пояснений и без \`\`\`.` : system;
    const text = String(await claudeImpl({ role: "filter", system: sys, prompt: user, timeoutMs: 60_000, maxTokens: maxTokens || 800 }));
    const parsed = json ? parseJsonLoose(text) : null;
    if (json && !parsed) throw new Error("ответ не JSON");
    return { text, json: parsed, provider: "claude" };
  } catch (err) {
    count("failures", "claude");
    errors.push(`claude: ${err.message}`);
    throw new Error(`LLM недоступен (${errors.join("; ")})`);
  }
}

export function llmStats() {
  rollDay();
  const now = Date.now();
  return {
    date: stats.date,
    requests: { ...stats.requests },
    failures: { ...stats.failures },
    byPurpose: { ...stats.byPurpose },
    cooling: Object.fromEntries([...cooling].filter(([, t]) => t > now).map(([m, t]) => [m, Math.ceil((t - now) / 1000)])),
    limits: JSON.parse(JSON.stringify(limits)),
    groqKey: Boolean(config.groqApiKey),
  };
}

export function llmStatsText() {
  const s = llmStats();
  const req = Object.entries(s.requests).map(([k, v]) => `${k} ${v}`).join(", ") || "запросов не было";
  const cool = Object.entries(s.cooling).map(([m, sec]) => `${m} ещё ${sec} с`).join(", ");
  return `Дешёвый LLM (${s.date}): ${s.groqKey ? "Groq подключён" : "нет GROQ_API_KEY — всё через Claude"}; сегодня: ${req}${cool ? `; на паузе: ${cool}` : ""}.`;
}

export function resetLLMState() {
  cooling.clear();
  for (const k of Object.keys(limits)) delete limits[k];
  stats.requests = {};
  stats.failures = {};
  stats.byPurpose = {};
}
