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

// Промпт автоответчика. Модель должна написать СЛЕДУЮЩЕЕ СООБЩЕНИЕ АЗИЗХОНА,
// а не отвечать ему как ассистент (иначе получается «Нужно сообщение от Хопа.
// Что он написал?»). Поэтому рамка явная: кто собеседник, что было раньше,
// что пришло сейчас, и живые образцы того, как Азизхон пишет сам.
// ctx: { chatName, styleSamples: [text], now: Date }
function buildPrompt(history, incomingText, ctx = {}) {
  const now = (ctx.now || new Date()).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" });
  const lines = [`[Сейчас в Ташкенте: ${now}. Собеседник: ${ctx.chatName || "неизвестно"}.]`];

  if (ctx.styleSamples?.length) {
    lines.push("", "[Как Азизхон реально пишет сам (его сообщения из разных чатов, только стиль — не факты):]");
    for (const sample of ctx.styleSamples) lines.push(`— ${sample}`);
  }

  lines.push("", "[Переписка до этого, старые сверху:]");
  if (history.length) {
    for (const m of history) lines.push(`${m.role === "customer" ? "Собеседник" : "Азизхон"}: ${m.text}`);
  } else {
    lines.push("(истории нет — возможно, переписка была до подключения бота)");
  }

  lines.push("", "[Новое от собеседника:]", incomingText);
  lines.push(
    "",
    "[Задача: служебные строки по формату, затем следующее сообщение Азизхона этому собеседнику. " +
      "Пишешь ОТ ЛИЦА Азизхона — не обращайся к Азизхону, не задавай ему вопросов, не объясняй, что ты бот-помощник.]"
  );
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
//
// Инструменты:
// - автоответчик клиентам и /day — БЕЗ инструментов (--allowedTools "" +
//   --permission-mode dontAsk): промпт приходит от постороннего человека в
//   Telegram, никакого доступа к файлам/командам/сети это дать не должно;
// - Рафаэль (личный чат, пишет только владелец) — только WebSearch и WebFetch:
//   интернет, но без файлов и команд. cwd всё равно пустая песочница.
//
// Картинки (фото, кадры видео) передаются прямо в сообщении через
// --input-format stream-json — это не файлы на диске и не инструменты.
// stream-json на входе требует stream-json на выходе: ответ — строка type=result.
//
// Сессии (--resume): Рафаэль и /day продолжают один разговор, как обычный чат
// с Claude, — CLI сам хранит его в ~/.claude и сжимает, когда он длинный.
const WEB_TOOLS = "WebSearch,WebFetch";

// Если бот запущен из-под Claude Code (например, тесты в облаке), не наследуем
// ID его сессии — иначе все вызовы пишут в одну чужую сессию. На сервере этих
// переменных нет.
function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return env;
}

// -> { text, sessionId }
function runClaudeCli({ prompt, systemFile, images = [], model, resumeId, webTools = false, timeoutMs = 60_000 }) {
  const withImages = images.length > 0;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--append-system-prompt-file",
        systemFile,
        "--allowedTools",
        webTools ? WEB_TOOLS : "",
        "--permission-mode",
        "dontAsk",
        ...(model ? ["--model", model] : []),
        ...(resumeId ? ["--resume", resumeId] : []),
        ...(withImages
          ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
          : ["--output-format", "json"]),
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd: sandboxDir, env: childEnv() }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p не ответил за ${Math.round(timeoutMs / 1000)} секунд`));
    }, timeoutMs);

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
        resolve({ text: parsed.result?.trim() || "", sessionId: parsed.session_id || null });
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

// Клиентский путь: без инструментов, без сессий, быстрая модель.
async function callViaSubscription(prompt, personaPath, images = [], model = config.claudeModelFast) {
  const { text } = await runClaudeCli({ prompt, systemFile: personaPath, images, model });
  return text;
}

// Сессия: продолжаем разговор; если сессия потерялась (новый сервер, стёрли
// ~/.claude) — начинаем новую, а не падаем.
async function runSession(opts) {
  try {
    return await runClaudeCli(opts);
  } catch (err) {
    if (!opts.resumeId || !/no conversation found|session .*not found|invalid session/i.test(err.message)) throw err;
    console.warn("[claude] Сессия не найдена, начинаю новую:", err.message.slice(0, 200));
    return runClaudeCli({ ...opts, resumeId: null });
  }
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

async function callViaApi(prompt, systemText, maxTokens, images = []) {
  const client = await getAnthropicClient();
  const content = images.length ? [...imageBlocks(images), { type: "text", text: prompt }] : prompt;
  const msg = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system: systemText,
    messages: [{ role: "user", content }],
  });
  const text = msg.content.find((b) => b.type === "text")?.text || "";
  return text.trim();
}

// Системный промпт, собранный из нескольких частей (персона + знания +
// свежий контекст), пишем во временный файл — CLI принимает только файл.
// Каталог отдельный от песочницы: там по-прежнему ничего нет.
const promptsDir = path.join(os.tmpdir(), "telegram-claude-bot-prompts");
fs.mkdirSync(promptsDir, { recursive: true });

function writeSystemFile(name, text) {
  const file = path.join(promptsDir, `${name}.md`);
  fs.writeFileSync(file, text);
  return file;
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
  "ack",
  "other",
]);
const PRODUCTS = new Set(["catalog", "barber", "other"]);
const CHAT_KINDS = new Set(["work", "personal"]);

// Экспортируется отдельно для scripts/test-intents.js — там нужен доступ
// к чистому парсеру на заготовленных ответах, без реального вызова Claude.
export function parseTriagedReply(raw) {
  // Служебные строки intent/product/chat идут в начале, в любом порядке;
  // пустые строки между ними не важны. Всё после них — текст ответа.
  const lines = raw.trim().split("\n");
  const headers = {};
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^(intent|product|chat):\s*(\S*)\s*$/i);
    if (!m) break;
    headers[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  if (!headers.intent) {
    return { intent: "other", product: "other", chat: "unknown", text: raw.trim() };
  }
  return {
    intent: INTENTS.has(headers.intent) ? headers.intent : "other",
    product: PRODUCTS.has(headers.product) ? headers.product : "other",
    // work — рабочий чат (клиент/заказчик), personal — друзья/знакомые/учёба.
    chat: CHAT_KINDS.has(headers.chat) ? headers.chat : "unknown",
    text: lines.slice(i).join("\n").trim(),
  };
}

function callClaude(prompt, personaPath, maxTokens, images = []) {
  return config.claudeMode === "api"
    ? callViaApi(prompt, fs.readFileSync(personaPath, "utf8"), maxTokens, images)
    : callViaSubscription(prompt, personaPath, images);
}

// images — [{ mediaType, data(base64) }] к текущему сообщению (фото, кадры видео).
export async function generateReply(history, incomingText, images = [], ctx = {}) {
  const raw = await callClaude(buildPrompt(history, incomingText, ctx), config.personaPath, 400, images);
  return parseTriagedReply(raw);
}

// Рафаэль: одна длинная сессия на чат + интернет. systemText собирает bot.js
// (персона + знания + память + список чатов). fallbackPrompt — для режима api,
// где сессий нет: там история передаётся текстом, как раньше.
// -> { text, sessionId }
export async function askRaphael({ prompt, images = [], sessionId, systemText, fallbackPrompt }) {
  if (config.claudeMode === "api") {
    return { text: await callViaApi(fallbackPrompt || prompt, systemText, 2000, images), sessionId: null };
  }
  return runSession({
    prompt,
    systemFile: writeSystemFile("raphael", systemText),
    images,
    model: config.claudeModelSmart,
    resumeId: sessionId,
    webTools: true,
    timeoutMs: 240_000,
  });
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

// Без сессии: история передаётся текстом (режим api и scripts/test-day.js).
export async function generateContentReply(history, incomingText, images = [], systemText = null) {
  const prompt = buildSecretaryPrompt(history, incomingText);
  const raw =
    config.claudeMode === "api"
      ? await callViaApi(prompt, systemText || fs.readFileSync(config.contentPersonaPath, "utf8"), 1500, images)
      : (
          await runClaudeCli({
            prompt,
            systemFile: systemText ? writeSystemFile("content", systemText) : config.contentPersonaPath,
            images,
            model: config.claudeModelSmart,
            timeoutMs: 120_000,
          })
        ).text;
  return { raw, ...parseContentReply(raw) };
}

// /day в сессии: интервью помнит весь разговор дня. Без инструментов.
// -> { raw, sessionId, ready, ... }
export async function continueContentSession({ prompt, images = [], sessionId, systemText }) {
  const { text, sessionId: newId } = await runSession({
    prompt,
    systemFile: writeSystemFile("content", systemText),
    images,
    model: config.claudeModelSmart,
    resumeId: sessionId,
    timeoutMs: 180_000,
  });
  return { raw: text, sessionId: newId, ...parseContentReply(text) };
}
