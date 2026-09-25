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
//
// Картинки (фото, кадры видео) передаются прямо в сообщении через
// --input-format stream-json — это не файлы на диске и не инструменты,
// ограничения выше (песочница, --allowedTools "") остаются теми же.
// stream-json на входе требует stream-json на выходе: ответ — строка type=result.
function callViaSubscription(prompt, personaPath, images = []) {
  const withImages = images.length > 0;
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
        ...(withImages
          ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
          : ["--output-format", "json"]),
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd: sandboxDir }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p не ответил за ${withImages ? 120 : 60} секунд`));
    }, withImages ? 120_000 : 60_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude -p завершился с кодом ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = withImages
          ? stdout
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
              .reverse()
              .find((event) => event.type === "result")
          : JSON.parse(stdout);
        if (!parsed) throw new Error("нет события result");
        if (parsed.is_error) throw new Error(parsed.result || "claude вернул ошибку");
        resolve(parsed.result?.trim() || "");
      } catch (e) {
        reject(new Error(`Не удалось разобрать ответ claude -p: ${e.message}\n${stdout.slice(-500)}`));
      }
    });

    if (withImages) {
      const message = {
        type: "user",
        message: { role: "user", content: [...imageBlocks(images), { type: "text", text: prompt }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } else {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

function imageBlocks(images) {
  return images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
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

async function callViaApi(prompt, personaPath, maxTokens, images = []) {
  const client = await getAnthropicClient();
  const persona = fs.readFileSync(personaPath, "utf8");
  const content = images.length ? [...imageBlocks(images), { type: "text", text: prompt }] : prompt;
  const msg = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system: persona,
    messages: [{ role: "user", content }],
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

function callClaude(prompt, personaPath, maxTokens, images = []) {
  return config.claudeMode === "api"
    ? callViaApi(prompt, personaPath, maxTokens, images)
    : callViaSubscription(prompt, personaPath, images);
}

// images — [{ mediaType, data(base64) }] к текущему сообщению (фото, кадры видео).
export async function generateReply(history, incomingText, images = []) {
  const raw = await callClaude(buildPrompt(history, incomingText), config.personaPath, 400, images);
  return parseTriagedReply(raw);
}

export async function generateSecretaryReply(history, incomingText, images = []) {
  return callClaude(buildSecretaryPrompt(history, incomingText), config.assistantPersonaPath, 2000, images);
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

export async function generateContentReply(history, incomingText, images = []) {
  const raw = await callClaude(buildSecretaryPrompt(history, incomingText), config.contentPersonaPath, 1500, images);
  return { raw, ...parseContentReply(raw) };
}
