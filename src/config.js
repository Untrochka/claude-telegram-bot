import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Отсутствует переменная окружения ${name} — заполни .env (см. .env.example)`);
  }
  return value;
}

const ownerTelegramId = Number(required("OWNER_TELEGRAM_ID"));
if (!Number.isInteger(ownerTelegramId)) {
  throw new Error("OWNER_TELEGRAM_ID должен быть числом (твой Telegram user id, узнать у @userinfobot)");
}

// AUTO_SEND_ENABLED не задан в .env -> считаем "включено" (можно выключить
// без правки .env через /auto off, см. state.js/bot.js).
const autoSendEnabledRaw = process.env.AUTO_SEND_ENABLED;
const autoSendEnabled = autoSendEnabledRaw === undefined ? true : autoSendEnabledRaw.trim().toLowerCase() === "true";

const autoSendIntents = (process.env.AUTO_SEND_INTENTS || "refusal,soft_no,price,examples")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  botToken: required("BOT_TOKEN"),
  ownerTelegramId,
  claudeMode: (process.env.CLAUDE_MODE || "subscription").trim(), // "subscription" | "api"
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  historyLimit: Number(process.env.HISTORY_LIMIT || 10),
  personaPath: path.join(__dirname, "persona.md"),
  assistantPersonaPath: path.join(__dirname, "assistant-persona.md"),
  contentPersonaPath: path.join(__dirname, "content-persona.md"),
  statePath: path.join(ROOT, "data", "state.json"),
  examplesDir: path.join(ROOT, "data", "examples"),
  untraChannelId: process.env.UNTRA_CHANNEL_ID || "@untra_dev",
  vlogChannelId: process.env.VLOG_CHANNEL_ID || "@untra_dev_vlog",
  // true — ничего не отправлять клиентам по-настоящему (ни автоответ, ни
  // ручное подтверждение ✅), только логировать и уведомлять владельца.
  dryRun: (process.env.DRY_RUN || "false").trim().toLowerCase() === "true",
  autoSendEnabled,
  autoSendIntents,
  // Расшифровка голосовых и звука из видео (Groq Whisper). Пусто — голос не
  // расшифровывается, бот просто сообщает о голосовом, как раньше.
  groqApiKey: (process.env.GROQ_API_KEY || "").trim(),
  groqWhisperModel: (process.env.GROQ_WHISPER_MODEL || "whisper-large-v3").trim(),
};

if (config.claudeMode === "api" && !config.anthropicApiKey) {
  throw new Error("CLAUDE_MODE=api, но ANTHROPIC_API_KEY пустой — добавь ключ в .env");
}
