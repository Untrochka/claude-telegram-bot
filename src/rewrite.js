// Переделка черновиков по словам владельца: кнопка ✏️, ответ (reply) на
// карточку или просьба Джарвису («измени ответ клиенту, слишком иишно»).
// Правки к ответам клиентам копятся и дальше учитываются автоответчиком —
// так бот меняет поведение без правки кода.
import fs from "node:fs";
import { config } from "./config.js";
import { runOneShot } from "./claudeClient.js";
import { readStrategy, notesText } from "./strategies.js";
import { checkPrices } from "./prices.js";
import {
  getDraft,
  updateDraft,
  getHistory,
  getChatMeta,
  getAgentValue,
  updateAgentValue,
  getStyleSamples,
} from "./state.js";
import { sendMessage, sendMessageWithButtons, editMessageText } from "./telegram.js";
import { applyCommentRewrite, isCancelText, dictatedText } from "./comments.js";
import { applyRedditRewrite } from "./reddit.js";

// Правила + последние правки для автоответчика (идут в каждый промпт клиенту).
export function clientRulesText() {
  const rules = notesText("clients");
  const fb = getAgentValue("clientFeedback", [])
    .slice(-10)
    .map((f) => `- ${f.text}`)
    .join("\n");
  return [rules && `Постоянные правила:\n${rules}`, fb && `Недавние правки к черновикам (учитывай похожие случаи):\n${fb}`]
    .filter(Boolean)
    .join("\n\n");
}

function remember(key, text) {
  updateAgentValue(key, [], (list) => {
    list.push({ text: text.trim().slice(0, 300), ts: Date.now() });
    if (list.length > 30) list.splice(0, list.length - 30);
  });
}

function chatLabel(chatId) {
  const { title } = getChatMeta(chatId);
  return title ? `${title} · #${chatId}` : `чат #${chatId}`;
}

export function clientCardText(d) {
  return `${d.extraLine || ""}💬 ${chatLabel(d.chatId)}:\n${d.customerText || "(сообщение клиента)"}\n\n✏️ Черновик ответа${d.intent ? ` (${d.intent})` : ""}:\n${d.text}`;
}

export function clientButtons(id) {
  return [
    [
      { text: "✅ Отправить", callback_data: `d:s:${id}` },
      { text: "✏️ Переписать", callback_data: `d:re:${id}` },
      { text: "🗑", callback_data: `d:x:${id}` },
    ],
  ];
}

export function postCardText(d) {
  return `📝 ${d.channelLabel}:\n\n${d.text}`;
}

export function postButtons(id) {
  return [
    [
      { text: "✅ Запостить", callback_data: `d:s:${id}` },
      { text: "✏️ Переписать", callback_data: `d:re:${id}` },
      { text: "🗑 Не постить", callback_data: `d:x:${id}` },
    ],
  ];
}

async function rewriteClientText(d, instruction) {
  const persona = fs.readFileSync(config.personaPath, "utf8");
  const history = getHistory(d.chatId)
    .slice(-10)
    .map((m) => `${m.role === "customer" ? "Собеседник" : "Азизхон"}: ${m.text}`)
    .join("\n");
  const samples = getStyleSamples(15).map((t) => `— ${t}`).join("\n");
  const raw = await runOneShot({
    role: "clients",
    system: `${persona}\n\n${clientRulesText()}`,
    prompt: [
      `[Как Азизхон реально пишет сам (только стиль):]\n${samples || "(нет образцов)"}`,
      `[Переписка, старые сверху:]\n${history || "(нет истории)"}`,
      `[Черновик, который Азизхону не понравился:]\n${d.text}`,
      `[Что Азизхон просит поменять — выполни буквально. Если он диктует смысл или слова, используй их и ничего не добавляй от себя:]\n${instruction}`,
      "[Задача: напиши НОВЫЙ вариант следующего сообщения Азизхона этому собеседнику, от его лица. Только сам текст сообщения — без строк intent/product/chat, без пояснений, без кавычек. Коротко и по-человечески, не как ИИ: без длинных тире, без списков, без «с радостью помогу».]",
    ].join("\n\n"),
    timeoutMs: 90_000,
  });
  return String(raw || "")
    .replace(/^(intent|product|chat):.*$/gim, "")
    .trim();
}

async function rewritePostText(d, instruction) {
  const raw = await runOneShot({
    role: "writer",
    system: `Ты переписываешь пост Азиза для его Telegram-канала по его просьбе.\n\n${readStrategy("telegram")}`,
    prompt: `Пост:\n<<<\n${d.text}\n>>>\n\nАзиз просит (выполни буквально, его формулировки сохраняй, от себя ничего не добавляй):\n${instruction}\n\nВерни только новый текст поста, простыми словами, без метафор и книжных слов.`,
    timeoutMs: 120_000,
  });
  return String(raw || "").trim();
}

// Главная точка: переделать любой черновик. -> true если черновик найден.
export async function applyDraftRewrite(draftId, instruction) {
  const d = getDraft(draftId);
  if (!d) return false;
  const pending = { draftId, ts: Date.now() };
  if (d.kind === "comment") return applyCommentRewrite(pending, instruction);
  if (d.kind === "reddit") return applyRedditRewrite(pending, instruction);
  if (d.kind !== "business" && d.kind !== "channel_post") return false;
  if (isCancelText(instruction)) {
    await sendMessage(config.ownerTelegramId, "Ок, правку не делаю. Черновик в карточке — ✅ или 🗑.");
    return true;
  }

  const own = instruction.match(/^текст\s*:\s*([\s\S]+)$/i)?.[1] || dictatedText(instruction);
  let text;
  if (own) {
    text = own.trim();
  } else if (d.kind === "business") {
    remember("clientFeedback", instruction);
    text = await rewriteClientText(d, instruction);
  } else {
    remember("postFeedback", instruction);
    text = await rewritePostText(d, instruction);
  }
  if (!text) {
    await sendMessage(config.ownerTelegramId, "Не получилось переписать. Пришли «текст: …» — поставлю твой вариант.");
    return true;
  }

  let extraLine = "";
  if (d.kind === "business" && d.intent === "price" && !checkPrices(text).ok) extraLine = "⚠️ цена не из прайса — проверь вручную.\n";
  updateDraft(draftId, { text, ...(d.kind === "business" ? { extraLine } : {}) });
  const nd = getDraft(draftId);
  if (d.cardMessageId) {
    const old = d.kind === "business" ? clientCardText(d) : postCardText(d);
    await editMessageText(config.ownerTelegramId, d.cardMessageId, `${old}\n\n↪️ Новая версия ниже.`).catch(() => {});
  }
  const msg =
    d.kind === "business"
      ? await sendMessageWithButtons(config.ownerTelegramId, clientCardText(nd), clientButtons(draftId))
      : await sendMessageWithButtons(config.ownerTelegramId, postCardText(nd), postButtons(draftId));
  updateDraft(draftId, { cardMessageId: msg?.message_id });
  return true;
}

// Для системного промпта Джарвиса: какие черновики сейчас ждут решения.
export function recentDraftsText(drafts) {
  if (!drafts.length) return "Сейчас нет черновиков на утверждении.";
  const kind = { business: "ответ клиенту", channel_post: "пост в канал", comment: "комментарий в Telegram", reddit: "ответ на Reddit" };
  return drafts
    .map((d) => {
      const who = d.kind === "business" ? ` (${getChatMeta(d.chatId).title || `чат ${d.chatId}`})` : d.kind === "comment" ? ` (@${d.username})` : "";
      return `- #${d.id} ${kind[d.kind]}${who}: ${d.text.replace(/\s+/g, " ").slice(0, 500)}`;
    })
    .join("\n");
}
