import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const API = `https://api.telegram.org/bot${config.botToken}`;

async function call(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

// Долгий polling — тот же паттерн, что в tg-notion-sync, только вместо MTProto
// используется обычный Bot API long polling с allowed_updates под business-сообщения.
export async function getUpdates(offset) {
  return call("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: [
      "business_connection",
      "business_message",
      "edited_business_message",
      "message",
      "callback_query",
      "channel_post", // ручные посты в Untra.dev — для баланса рубрик в /day
    ],
  });
}

export async function getBusinessConnection(connectionId) {
  return call("getBusinessConnection", { business_connection_id: connectionId });
}

export async function sendBusinessMessage(connectionId, chatId, text) {
  return call("sendMessage", {
    business_connection_id: connectionId,
    chat_id: chatId,
    text,
  });
}

// Обычное личное сообщение (не Business API) — канал секретаря с владельцем.
export async function sendMessage(chatId, text) {
  return call("sendMessage", { chat_id: chatId, text });
}

// Личное сообщение с inline-кнопками — карточка черновика на утверждение.
export async function sendMessageWithButtons(chatId, text, inlineKeyboard) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function editMessageText(chatId, messageId, text) {
  return call("editMessageText", { chat_id: chatId, message_id: messageId, text });
}

export async function answerCallbackQuery(callbackQueryId, text) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// Альбом фото для intent: examples (product: catalog), см. data/examples/.
// Multipart через встроенные FormData/Blob (Node 18+), без новых зависимостей.
export async function sendPhotoAlbum(connectionId, chatId, filePaths) {
  const form = new FormData();
  form.append("business_connection_id", connectionId);
  form.append("chat_id", String(chatId));
  const media = filePaths.map((filePath, i) => ({ type: "photo", media: `attach://file${i}` }));
  form.append("media", JSON.stringify(media));
  filePaths.forEach((filePath, i) => {
    const buf = fs.readFileSync(filePath);
    form.append(`file${i}`, new Blob([buf]), path.basename(filePath));
  });
  const res = await fetch(`${API}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API sendMediaGroup failed: ${data.description || res.status}`);
  }
  return data.result;
}

// Удаление уже отправленных клиенту сообщений (кнопка "🗑 Удалить у клиента"
// после автоответа). Работает только если бизнес-подключение дало право
// can_delete_sent_messages — это отдельно проверяется в bot.js/state.js.
export async function deleteBusinessMessages(connectionId, messageIds) {
  return call("deleteBusinessMessages", {
    business_connection_id: connectionId,
    message_ids: messageIds,
  });
}

// Регистрация команд, чтобы они предлагались при вводе "/" в Telegram.
// scope — например { type: "chat", chat_id } для персонального меню владельца.
export async function setMyCommands(commands, scope) {
  return call("setMyCommands", scope ? { commands, scope } : { commands });
}

// --- Файлы (голосовые, фото, видео) ---
// Bot API отдаёт ботам файлы только до 20 МБ — большее скачать нельзя.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export async function getFile(fileId) {
  return call("getFile", { file_id: fileId });
}

// Возвращает Buffer. URL содержит токен бота — не логировать.
export async function downloadFile(filePath) {
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${filePath}`);
  if (!res.ok) throw new Error(`Не удалось скачать файл Telegram: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Сообщение с HTML-разметкой (см. src/format.js). Если Telegram не принял
// разметку — повторяем тем же текстом без разметки, чтобы ответ не потерялся.
export async function sendHtmlMessage(chatId, html, plainFallback) {
  try {
    return await call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
  } catch (err) {
    if (!/can't parse entities|unsupported start tag|can't find end tag/i.test(err.message)) throw err;
    console.warn("[telegram] HTML не принят, отправляю без разметки:", err.message);
    return call("sendMessage", { chat_id: chatId, text: plainFallback });
  }
}

// "печатает…" в шапке чата, пока идёт расшифровка/ответ (живёт ~5 секунд).
export async function sendChatAction(chatId, action = "typing") {
  return call("sendChatAction", { chat_id: chatId, action });
}
