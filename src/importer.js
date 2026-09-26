// Импорт переписок из экспорта Telegram Desktop (Настройки → Продвинутые →
// Экспорт данных, или в чате ⋮ → Экспорт истории; формат JSON).
// Bot API не даёт боту читать старые сообщения — это единственный честный
// способ показать Рафаэлю переписку, которая была до подключения бота.
//
// Поддерживаются оба формата:
// - экспорт одного чата: { name, type, id, messages: [...] }
// - полный экспорт аккаунта: { chats: { list: [ {name, type, id, messages}, ... ] } }
// Берём только личные чаты (type "personal_chat") — это те же собеседники,
// что пишут в бизнес-аккаунт; id личного чата = user id = chat.id в Bot API.

const MEDIA_LABELS = {
  voice_message: "[голосовое]",
  video_message: "[кружок]",
  video_file: "[видео]",
  audio_file: "[аудио]",
  sticker: "[стикер]",
  animation: "[гиф]",
};

function flattenText(text) {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map((part) => (typeof part === "string" ? part : part.text || "")).join("");
  return "";
}

function messageText(m) {
  const text = flattenText(m.text).trim();
  const media = m.photo ? "[фото]" : MEDIA_LABELS[m.media_type] || (m.file ? "[файл]" : "");
  return [media, text].filter(Boolean).join(" ");
}

// ownerId — Telegram id Азизхона: его сообщения становятся role "azizhon".
export function parseTelegramExport(json, ownerId, perChatLimit = 300) {
  const rawChats = Array.isArray(json?.chats?.list) ? json.chats.list : json?.messages ? [json] : [];
  const ownerFrom = `user${ownerId}`;

  return rawChats
    .filter((c) => c.type === "personal_chat" && Array.isArray(c.messages) && c.id)
    .map((c) => {
      const messages = c.messages
        .filter((m) => m.type === "message")
        .map((m) => ({
          role: m.from_id === ownerFrom ? "azizhon" : "customer",
          text: messageText(m),
          ts: Number(m.date_unixtime) * 1000 || Date.parse(m.date) || 0,
        }))
        .filter((m) => m.text && m.ts)
        .slice(-perChatLimit);
      return { chatId: String(c.id), title: c.name || "", messages };
    })
    .filter((c) => c.messages.length);
}
