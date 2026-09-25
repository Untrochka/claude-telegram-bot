import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

// Пустая песочница вместо папки проекта: даже если что-то из read-only
// набора инструментов сработает в обход --allowedTools "", там физически
// нечего читать — ни .env с токенами, ни остального кода бота. Промпт
// в claude -p приходит от постороннего человека в Telegram, это
// потенциально враждебный ввод (prompt injection), поэтому cwd не должен
// быть папкой, где лежат секреты.
const sandboxDir = path.join(os.tmpdir(), "telegram-claude-bot-sandbox");
fs.mkdirSync(sandboxDir, { recursive: true });

function buildPrompt(history, incomingText) {
  const lines = history.map((m) => `${m.role === "customer" ? "Собеседник" : "Азизхон"}: ${m.text}`);
  lines.push(`Собеседник: ${incomingText}`);
  lines.push("Азизхон:");
  return lines.join("\n");
}

function secretaryRoleLabel(role) {
  if (role === "azizhon") return "Азизхон";
  if (role === "context") return "Контекст";
  return "Ассистент";
}

function buildSecretaryPrompt(history, incomingText) {
  const lines = history.map((m) => `${secretaryRoleLabel(m.role)}: ${m.text}`);
  lines.push(`Азизхон: ${incomingText}`);
  lines.push("Ассистент:");
  return lines.join("\n");
}

// Режим "subscription": дёргаем локально установленный Claude Code CLI (`claude -p`).
// Он использует твой Pro-логин (claude login), НЕ отдельный API-ключ — это то самое
// "бесплатно, пока тестируешь". Важно: без --bare CLI подхватывает subscription-логин;
// с --bare он требует ANTHROPIC_API_KEY, поэтому здесь --bare НЕ используем.
// Инструментов у Claude нет (--allowedTools "" + --permission-mode dontAsk) — это просто
// генерация текста ответа, никакого доступа к файлам/команде это дать не должно,
// потому что промпт приходит от постороннего человека в Telegram.
function callViaSubscription(prompt, personaPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--append-system-prompt-file",
        personaPath,
        "--allowedTools",
        "",
        "--permission-mode",
        "dontAsk",
        "--output-format",
        "json",
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd: sandboxDir }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("claude -p не ответил за 60 секунд"));
    }, 60_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude -p завершился с кодом ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result?.trim() || "");
      } catch (e) {
        reject(new Error(`Не удалось разобрать ответ claude -p: ${e.message}\n${stdout}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

let anthropicClientPromise;
async function getAnthropicClient() {
  if (!anthropicClientPromise) {
    anthropicClientPromise = import("@anthropic-ai/sdk").then(
      ({ default: Anthropic }) => new Anthropic({ apiKey: config.anthropicApiKey })
    );
  }
  return anthropicClientPromise;
}

async function callViaApi(prompt, personaPath, maxTokens) {
  const client = await getAnthropicClient();
  const persona = fs.readFileSync(personaPath, "utf8");
  const msg = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system: persona,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.find((b) => b.type === "text")?.text || "";
  return text.trim();
}

// Формат ответа (см. persona.md): первая строка "intent: <значение>", вторая
// "product: <значение>", третья пустая, дальше сам текст ответа клиенту.
// Если формат не распознан — считаем intent/product "other" и берём в текст
// весь ответ целиком (лучше отдать это черновиком на утверждение, чем потерять).
const INTENTS = new Set([
  "refusal",
  "soft_no",
  "price",
  "examples",
  "redirect",
  "interested",
  "autoreply",
  "urgent",
  "spam",
  "other",
]);
const PRODUCTS = new Set(["catalog", "barber", "other"]);

// Экспортируется отдельно для scripts/test-intents.js — там нужен доступ
// к чистому парсеру на заготовленных ответах, без реального вызова Claude.
export function parseTriagedReply(raw) {
  const match = raw.match(/^intent:\s*(\S+)\s*\nproduct:\s*(\S+)\s*\n\s*\n([\s\S]*)$/i);
  if (!match) {
    return { intent: "other", product: "other", text: raw.trim() };
  }
  const intentRaw = match[1].trim().toLowerCase();
  const productRaw = match[2].trim().toLowerCase();
  return {
    intent: INTENTS.has(intentRaw) ? intentRaw : "other",
    product: PRODUCTS.has(productRaw) ? productRaw : "other",
    text: match[3].trim(),
  };
}

export async function generateReply(history, incomingText) {
  const prompt = buildPrompt(history, incomingText);
  const raw =
    config.claudeMode === "api"
      ? await callViaApi(prompt, config.personaPath, 300)
      : await callViaSubscription(prompt, config.personaPath);
  return parseTriagedReply(raw);
}

export async function generateSecretaryReply(history, incomingText) {
  const prompt = buildSecretaryPrompt(history, incomingText);
  if (config.claudeMode === "api") {
    return callViaApi(prompt, config.assistantPersonaPath, 1500);
  }
  return callViaSubscription(prompt, config.assistantPersonaPath);
}

// См. content-persona.md — первая строка READY_TO_POST означает, что дальше
// идут готовые посты в блоках ===UNTRA===/===VLOG=== и подсказка к посту
// в ===NOTES===, иначе это просто продолжение интервью, без парсинга.
// Экспортируется для scripts/test-day.js.
export function parseContentReply(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("READY_TO_POST")) {
    return { ready: false, message: trimmed };
  }
  const blocks = (name) =>
    [...trimmed.matchAll(new RegExp(`===${name}===\\s*([\\s\\S]*?)(?=\\n===(?:UNTRA|VLOG|NOTES)===|$)`, "g"))]
      .map((m) => m[1].trim())
      .filter(Boolean);
  // UNTRA может быть до 2 раз (насыщенный день), остальные — по одному.
  return {
    ready: true,
    untra: blocks("UNTRA").slice(0, 2),
    vlog: blocks("VLOG")[0] || null,
    notes: blocks("NOTES")[0] || null,
  };
}

export async function generateContentReply(history, incomingText) {
  const prompt = buildSecretaryPrompt(history, incomingText);
  const raw =
    config.claudeMode === "api"
      ? await callViaApi(prompt, config.contentPersonaPath, 1500)
      : await callViaSubscription(prompt, config.contentPersonaPath);
  return { raw, ...parseContentReply(raw) };
}
