// Стриминг ответа в Telegram: первое сообщение появляется, как только модель
// начала писать, дальше оно редактируется по мере генерации (не чаще раза
// в ~1.5 с — лимиты Telegram). В конце — финальный текст с HTML-разметкой,
// длинное добивается следующими сообщениями.
import { sendMessage, sendHtmlMessage, editHtmlMessage, editPlainQuiet, deleteMessage } from "./telegram.js";
import { toTelegramHtml, splitForTelegram } from "./format.js";

const EDIT_EVERY_MS = 1500;
const MIN_FIRST_CHARS = 12;
const PREVIEW_LIMIT = 3500;

// transform(text) -> текст для показа или null (не показывать, например
// служебные строки [[CHAT: …]] или READY_TO_POST).
export function createStreamer(chatId, { transform } = {}) {
  let messageId = null;
  let lastShown = "";
  let latest = "";
  let lastEditAt = 0;
  let timer = null;
  let chain = Promise.resolve();
  let closed = false;

  const enqueue = (fn) => {
    chain = chain.then(fn).catch((err) => console.warn("[stream] Ошибка обновления:", err.message));
    return chain;
  };

  const flush = () => {
    timer = null;
    if (closed) return;
    const text = latest;
    if (!text || text === lastShown) return;
    lastEditAt = Date.now();
    lastShown = text;
    enqueue(async () => {
      if (closed) return;
      const shown = `${text.slice(0, PREVIEW_LIMIT)}${text.length > PREVIEW_LIMIT ? "…" : ""} ▌`;
      if (!messageId) {
        const sent = await sendMessage(chatId, shown);
        messageId = sent?.message_id || null;
      } else {
        await editPlainQuiet(chatId, messageId, shown);
      }
    });
  };

  const schedule = () => {
    if (timer || closed) return;
    const wait = Math.max(0, EDIT_EVERY_MS - (Date.now() - lastEditAt));
    timer = setTimeout(flush, wait);
  };

  return {
    // Накопленный текст модели.
    update(fullText) {
      const shown = transform ? transform(fullText) : fullText;
      if (shown === null || shown === undefined) return;
      if (!messageId && shown.trim().length < MIN_FIRST_CHARS) return;
      latest = shown;
      schedule();
    },
    // Служебный статус («📂 читаю переписку…») вместо текста.
    status(text) {
      latest = text;
      schedule();
    },
    // Финал: заменить превью готовым форматированным ответом.
    async finish(finalMd) {
      closed = true;
      if (timer) clearTimeout(timer);
      await chain;
      if (!finalMd) {
        if (messageId) await deleteMessage(chatId, messageId).catch(() => {});
        return;
      }
      const chunks = splitForTelegram(finalMd);
      let rest = chunks;
      if (messageId) {
        await editHtmlMessage(chatId, messageId, toTelegramHtml(chunks[0]), chunks[0]);
        rest = chunks.slice(1);
      }
      for (const chunk of rest) await sendHtmlMessage(chatId, toTelegramHtml(chunk), chunk);
    },
    // Убрать превью (например, когда вместо текста будут карточки постов).
    async discard() {
      closed = true;
      if (timer) clearTimeout(timer);
      await chain;
      if (messageId) await deleteMessage(chatId, messageId).catch(() => {});
    },
  };
}
