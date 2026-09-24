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
  untraChannelId: process.env.UNTRA_CHANNEL_ID || "@untra_dev",
  vlogChannelId: process.env.VLOG_CHANNEL_ID || "@untra_dev_vlog",
};

if (config.claudeMode === "api" && !config.anthropicApiKey) {
  throw new Error("CLAUDE_MODE=api, но ANTHROPIC_API_KEY пустой — добавь ключ в .env");
}
