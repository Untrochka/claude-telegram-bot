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
