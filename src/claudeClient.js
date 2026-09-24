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

// Первая строка ответа — метка срочности (см. persona.md), остальное — сам ответ клиенту.
const URGENCY_LABELS = new Set(["urgent", "normal", "spam"]);

function parseTriagedReply(raw) {
  const firstLineEnd = raw.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? raw : raw.slice(0, firstLineEnd)).trim().toLowerCase();
  if (firstLineEnd !== -1 && URGENCY_LABELS.has(firstLine)) {
    return { urgency: firstLine, text: raw.slice(firstLineEnd + 1).trim() };
  }
  return { urgency: "normal", text: raw.trim() };
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
// идут готовые посты в блоках ===UNTRA===/===VLOG===, иначе это просто
// продолжение интервью (вопросы/уточнения), без парсинга.
function parseContentReply(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("READY_TO_POST")) {
    return { ready: false, message: trimmed };
  }
  const untra = trimmed.match(/===UNTRA===\s*([\s\S]*?)(?=\n===VLOG===|$)/)?.[1]?.trim() || null;
  const vlog = trimmed.match(/===VLOG===\s*([\s\S]*)$/)?.[1]?.trim() || null;
  return { ready: true, untra, vlog };
}

export async function generateContentReply(history, incomingText) {
  const prompt = buildSecretaryPrompt(history, incomingText);
  const raw =
    config.claudeMode === "api"
      ? await callViaApi(prompt, config.contentPersonaPath, 1500)
      : await callViaSubscription(prompt, config.contentPersonaPath);
  return { raw, ...parseContentReply(raw) };
}
