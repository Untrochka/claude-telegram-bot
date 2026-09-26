import fs from "node:fs";
import { config } from "./config.js";
import {
  getUpdates,
  getBusinessConnection,
  sendBusinessMessage,
  sendMessage,
  sendMessageWithButtons,
  sendPhotoAlbum,
  deleteBusinessMessages,
  editMessageText,
  answerCallbackQuery,
  setMyCommands,
  sendHtmlMessage,
  sendChatAction,
  getFile,
  downloadFile,
  MAX_DOWNLOAD_BYTES,
} from "./telegram.js";
import {
  getLastUpdateId,
  setLastUpdateId,
  getHistory,
  pushHistory,
  getCachedOwnerId,
  cacheOwnerId,
  cacheConnectionRights,
  getConnectionRights,
  createDraft,
  getDraft,
  deleteDraft,
  createTask,
  listOpenTasks,
  completeTask,
  getDueUnnotifiedTasks,
  markTaskNotified,
  listChatSummaries,
  clearHistory,
  isContentModeActive,
  setContentMode,
  hasAzizhonEverReplied,
  getLastAzizhonTs,
  canAutoSendNow,
  recordAutoSend,
  getTodayAutoSendCount,
  getAutoSendToggle,
  setAutoSendToggle,
  addRecentPost,
  getRecentPosts,
  addStyleSample,
  getStyleSamples,
  setChatMeta,
  getChatMeta,
  clearSession,
  addMemory,
  listMemory,
  removeMemory,
  importChatHistory,
} from "./state.js";
import { generateReply } from "./claudeClient.js";
import { raphaelTurn, resetRaphael, contentTurn, memoryText } from "./raphael.js";
import { parseTelegramExport } from "./importer.js";
import { getTemplate } from "./templates.js";
import { checkPrices } from "./prices.js";
import { MENU_COMMANDS, buildHelpText } from "./commands.js";
import { extractMedia, hasMedia, MediaError } from "./media.js";
import { toTelegramHtml, splitForTelegram } from "./format.js";

console.log(`[bot] Запуск. Режим Claude: ${config.claudeMode}${config.dryRun ? " (DRY_RUN)" : ""}`);

// Азизхон не писал в чат последние 15 минут — считаем, что диалог сейчас не
// ведёт он сам, автоответ можно рассматривать (см. CLAUDE_CODE_TASK.md п. 3.4).
const AUTO_SEND_QUIET_MS = 15 * 60 * 1000;

function isAutoSendActive() {
  const override = getAutoSendToggle();
  return override === undefined || override === null ? config.autoSendEnabled : override;
}

// Единая точка отправки сообщения клиенту. В DRY_RUN ничего реально не уходит —
// только лог и уведомление владельцу, что было бы отправлено (ни автоответ,
// ни ручное подтверждение ✅ в этом режиме клиента не трогают).
async function deliverToCustomer(connectionId, chatId, text) {
  if (config.dryRun) {
    console.log(`[bot] DRY_RUN: не отправляю клиенту в чат ${chatId}.`);
    await sendMessage(config.ownerTelegramId, `🧪 DRY_RUN — отправил бы клиенту (чат ${chatId}):\n${text}`);
    return null;
  }
  return sendBusinessMessage(connectionId, chatId, text);
}

async function sendCatalogExamplesAlbum(connectionId, chatId) {
  if (config.dryRun) return;
  let files;
  try {
    files = fs.readdirSync(config.examplesDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
  } catch {
    return; // папки нет — просто нечего слать
  }
  if (!files.length) return;
  try {
    await sendPhotoAlbum(
      connectionId,
      chatId,
      files.map((f) => `${config.examplesDir}/${f}`)
    );
  } catch (err) {
    console.error("[bot] Не удалось отправить альбом примеров:", err.message);
  }
}

function hasNewCustomerMessageSince(chatId, ts) {
  const history = getHistory(chatId);
  const last = history[history.length - 1];
  return Boolean(last && last.role === "customer" && last.ts > ts);
}

function urgencyLabelFor(intent) {
  return { urgent: "🔴 Срочно", spam: "⚪ Спам/не по делу" }[intent] || "🟡 Обычное";
}

// "Имя @username · #id" — чтобы в карточке было видно, кто это, а не голый id.
function chatLabel(chatId) {
  const { title } = getChatMeta(chatId);
  return title ? `${title} · #${chatId}` : `чат #${chatId}`;
}

function chatTitleFrom(chat) {
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.title || "";
  return [name, chat.username ? `@${chat.username}` : ""].filter(Boolean).join(" ");
}

async function sendDraftCard(connectionId, chatId, intent, customerText, replyText, extraLine = "") {
  const draftId = createDraft({ kind: "business", connectionId, chatId, text: replyText });
  const preview = `${urgencyLabelFor(intent)}\n${extraLine}💬 ${chatLabel(chatId)}:\n${customerText}\n\n✏️ Черновик ответа (${intent}):\n${replyText}`;
  await sendMessageWithButtons(config.ownerTelegramId, preview, [
    [
      { text: "✅ Отправить", callback_data: `d:s:${draftId}` },
      { text: "🗑 Не отправлять", callback_data: `d:x:${draftId}` },
    ],
  ]);
  console.log(`[bot] Черновик #${draftId} (${intent}) на утверждение (чат ${chatId}).`);
}

// Очередь неблокирующей задержки перед автоотправкой (60-180с, см. п. 3.4),
// проверяется в основном цикле рядом с checkReminders, чтобы не тормозить
// long polling.
const autoSendQueue = [];

function scheduleAutoSend(item) {
  const delayMs = (60 + Math.random() * 120) * 1000;
  autoSendQueue.push({ ...item, sendAt: Date.now() + delayMs, queuedAt: Date.now() });
  console.log(`[bot] Автоответ intent=${item.intent} в чат ${item.chatId} запланирован через ${Math.round(delayMs / 1000)}с.`);
}

async function executeAutoSend(item) {
  const { connectionId, chatId, intent, product, customerText, replyText, queuedAt } = item;

  const stillOk =
    isAutoSendActive() &&
    getLastAzizhonTs(chatId) <= queuedAt &&
    !hasNewCustomerMessageSince(chatId, queuedAt) &&
    canAutoSendNow(chatId, intent);

  if (!stillOk) {
    console.log(`[bot] Автоответ intent=${intent} в чат ${chatId} отменён, превращаю в черновик.`);
    await sendDraftCard(connectionId, chatId, intent, customerText, replyText, "⏸ Автоответ отменён (что-то изменилось), нужно решение вручную.\n");
    return;
  }

  try {
    if (intent === "examples" && product === "catalog") {
      await sendCatalogExamplesAlbum(connectionId, chatId);
    }
    const sent = await deliverToCustomer(connectionId, chatId, replyText);
    pushHistory(chatId, "azizhon", replyText);
    recordAutoSend(chatId, intent);

    const buttons = [];
    if (sent?.message_id && getConnectionRights(connectionId)) {
      const delDraftId = createDraft({ kind: "auto_sent", connectionId, chatId, messageId: sent.message_id });
      buttons.push({ text: "🗑 Удалить у клиента", callback_data: `d:del:${delDraftId}` });
    }
    const card = `🤖 Отправлено автоматически (${intent})\n💬 ${chatLabel(chatId)}:\n${customerText}\n\n✏️ Ответ:\n${replyText}`;
    if (buttons.length) {
      await sendMessageWithButtons(config.ownerTelegramId, card, [buttons]);
    } else {
      await sendMessage(config.ownerTelegramId, card);
    }
  } catch (err) {
    console.error(`[bot] Ошибка автоотправки в чате ${chatId}:`, err.message);
  }
}

async function processAutoSendQueue() {
  const now = Date.now();
  const ready = autoSendQueue.filter((item) => item.sendAt <= now);
  for (const item of ready) {
    autoSendQueue.splice(autoSendQueue.indexOf(item), 1);
    await executeAutoSend(item);
  }
}

async function resolveOwnerId(connectionId) {
  const cached = getCachedOwnerId(connectionId);
  if (cached) return cached;
  const conn = await getBusinessConnection(connectionId);
  const ownerId = conn.user?.id;
  if (ownerId) cacheOwnerId(connectionId, ownerId);
  cacheConnectionRights(connectionId, conn.rights?.can_delete_sent_messages);
  return ownerId;
}

async function notifyNonTextMessage(chatId, msg, reason = "") {
  const kind = msg.voice
    ? "🎤 Голосовое"
    : msg.video_note
      ? "🎥 Кружок"
      : msg.video
        ? "🎥 Видео"
        : msg.photo
          ? "📷 Фото без подписи"
          : null;
  if (!kind) return; // стикеры и прочее нестандартное — как и раньше, молча пропускаем
  const why = reason ? ` (не смог разобрать: ${reason})` : "";
  await sendMessage(config.ownerTelegramId, `${kind} от ${chatLabel(chatId)} — ответь сам, бот не отвечает${why}.`);
}

// Пачка сообщений от одного человека: люди пишут по 3–4 сообщения подряд,
// и черновик на каждое получается без учёта следующих. Ждём паузу и
// отвечаем один раз на всю пачку.
const BATCH_QUIET_MS = 40_000;
const MAX_BATCH_IMAGES = 8;
const pendingBatches = new Map(); // chatId -> { connectionId, texts, images, hasMedia, timer }

function cancelBatch(chatId) {
  const batch = pendingBatches.get(chatId);
  if (!batch) return;
  clearTimeout(batch.timer);
  pendingBatches.delete(chatId);
}

function addToBatch(chatId, connectionId, text, images, isMedia) {
  const batch = pendingBatches.get(chatId) || { connectionId, texts: [], images: [], hasMedia: false };
  clearTimeout(batch.timer);
  batch.texts.push(text);
  batch.images.push(...images.slice(0, MAX_BATCH_IMAGES - batch.images.length));
  batch.hasMedia = batch.hasMedia || isMedia;
  batch.timer = setTimeout(() => {
    pendingBatches.delete(chatId);
    replyToBatch(chatId, batch).catch((err) =>
      console.error(`[bot] Ошибка генерации ответа в чате ${chatId}:`, err.message)
    );
  }, BATCH_QUIET_MS);
  pendingBatches.set(chatId, batch);
}

async function handleBusinessMessage(msg) {
  const connectionId = msg.business_connection_id;
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;

  if (!connectionId) return;

  const ownerId = await resolveOwnerId(connectionId);

  if (!ownerId || ownerId !== config.ownerTelegramId) {
    console.warn(
      `[bot] Business-подключение ${connectionId} принадлежит чужому аккаунту (${ownerId}), игнорирую.`
    );
    return;
  }

  if (msg.from?.id === ownerId) {
    // Сообщение, которое отправил сам бот от имени Азизхона (✅ или автоответ),
    // приходит обратно апдейтом — в историю оно уже записано, в образцы стиля
    // его брать нельзя.
    if (msg.sender_business_bot) return;
    // Азизхон сам ответил в этом чате — запоминаем для контекста и как образец
    // его стиля; недоотвеченную пачку отменяем, он ведёт диалог сам.
    cancelBatch(chatId);
    if (text) {
      pushHistory(chatId, "azizhon", text);
      addStyleSample(text);
    }
    console.log(`[bot] Азизхон ответил лично в чате ${chatId}, бот молчит.`);
    return;
  }

  const title = chatTitleFrom(msg.chat);
  if (title && title !== getChatMeta(chatId).title) setChatMeta(chatId, { title });

  // Голосовое / фото / видео -> расшифровка и картинки для модели.
  // Ответ на такое сообщение — только черновик (расшифровка может ошибаться).
  let incoming = text || "";
  let images = [];
  let mediaKind = null;
  if (hasMedia(msg)) {
    try {
      const media = await extractMedia(msg);
      if (media) {
        incoming = media.text;
        images = media.images;
        mediaKind = media.kind;
      }
    } catch (err) {
      console.error(`[bot] Не смог разобрать медиа в чате ${chatId}:`, err.message);
      if (!text) {
        await notifyNonTextMessage(chatId, msg, err instanceof MediaError ? err.message : "ошибка, см. логи");
        return;
      }
    }
  }

  if (!incoming) {
    await notifyNonTextMessage(chatId, msg);
    return;
  }

  console.log(`[bot] Новое сообщение в чате ${chatId}${mediaKind ? ` (${mediaKind})` : ""}: ${incoming.slice(0, 80)}`);
  pushHistory(chatId, "customer", incoming);
  addToBatch(chatId, connectionId, incoming, images, Boolean(mediaKind));
}

async function replyToBatch(chatId, batch) {
  const { connectionId, texts, images } = batch;
  const customerText = texts.join("\n");

  // Сообщения пачки уже лежат в конце истории — в "раньше" их не дублируем.
  const history = getHistory(chatId);
  const prior = history.slice(0, Math.max(0, history.length - texts.length)).slice(-config.historyLimit);

  const { intent, product, chat, text: modelReply } = await generateReply(prior, customerText, images, {
    chatName: getChatMeta(chatId).title,
    styleSamples: getStyleSamples(),
  });
  if (chat !== "unknown") setChatMeta(chatId, { kind: chat });
  console.log(`[bot] Чат ${chatId}: intent=${intent} product=${product} chat=${chat}`);

  if (intent === "autoreply") {
    await sendMessage(config.ownerTelegramId, `🤖 Автоответчик у ${chatLabel(chatId)} — ждём живого человека.\n💬 ${customerText}`);
    return;
  }

  // «Хоп», «ок», 👍 — отвечать не нужно. Личные чаты (друзья, одноклассники) —
  // черновик не нужен: Telegram и так покажет сообщение, а бот там только
  // выдумывает контекст и берёт обязательства за Азизхона.
  if (intent === "ack" || chat === "personal") {
    console.log(`[bot] Чат ${chatId}: без черновика (${intent === "ack" ? "подтверждение" : "личный чат"}).`);
    return;
  }

  let outgoingText = modelReply;
  let priceWarning = "";

  if (intent === "refusal" || intent === "soft_no" || intent === "examples") {
    outgoingText = getTemplate(intent, product) || modelReply;
  } else if (intent === "price") {
    const { ok } = checkPrices(modelReply);
    if (!ok) priceWarning = "⚠️ цена не из прайса — проверь вручную.\n";
  }

  if (!outgoingText) {
    console.warn("[bot] Пустой ответ от Claude, пропускаю отправку.");
    return;
  }

  const eligibleForAutoSend =
    chat === "work" &&
    !batch.hasMedia &&
    !priceWarning &&
    config.autoSendIntents.includes(intent) &&
    isAutoSendActive() &&
    hasAzizhonEverReplied(chatId) &&
    Date.now() - getLastAzizhonTs(chatId) > AUTO_SEND_QUIET_MS &&
    canAutoSendNow(chatId, intent);

  if (eligibleForAutoSend) {
    scheduleAutoSend({ connectionId, chatId, intent, product, customerText, replyText: outgoingText });
    return;
  }

  await sendDraftCard(connectionId, chatId, intent, customerText, outgoingText, priceWarning);
}

async function handleCallbackQuery(query) {
  if (query.from?.id !== config.ownerTelegramId) {
    await answerCallbackQuery(query.id, "Не твоё.");
    return;
  }

  const [, action, draftId] = (query.data || "").split(":");
  const draft = getDraft(draftId);
  if (!draft) {
    await answerCallbackQuery(query.id, "Черновик уже не актуален.");
    return;
  }

  const cardChatId = query.message.chat.id;
  const cardMessageId = query.message.message_id;
  const cardText = query.message.text || "";

  const isPost = draft.kind === "channel_post";

  if (action === "s") {
    try {
      if (isPost) {
        await sendMessage(draft.channelId, draft.text);
        if (draft.channelId === config.untraChannelId) addRecentPost(draft.text);
        console.log(`[bot] Пост #${draftId} опубликован в ${draft.channelLabel} (${draft.channelId}).`);
      } else {
        await deliverToCustomer(draft.connectionId, draft.chatId, draft.text);
        pushHistory(draft.chatId, "azizhon", draft.text);
        console.log(`[bot] Черновик #${draftId} отправлен в чат ${draft.chatId}.`);
      }
      deleteDraft(draftId);
      await editMessageText(cardChatId, cardMessageId, `${cardText}\n\n${isPost ? "✅ Опубликовано." : "✅ Отправлено."}`);
      await answerCallbackQuery(query.id, isPost ? "Опубликовано" : "Отправлено");
    } catch (err) {
      console.error(`[bot] Ошибка отправки черновика #${draftId}:`, err.message);
      await answerCallbackQuery(query.id, "Ошибка отправки, см. логи");
    }
  } else if (action === "x") {
    deleteDraft(draftId);
    const rejectLabel = isPost ? "🗑 Не опубликовано." : "🗑 Отклонено. Ответь клиенту лично в чате при желании.";
    await editMessageText(cardChatId, cardMessageId, `${cardText}\n\n${rejectLabel}`);
    await answerCallbackQuery(query.id, isPost ? "Не опубликовано" : "Отклонено");
    console.log(`[bot] Черновик #${draftId} отклонён.`);
  } else if (action === "del") {
    // Кнопка "🗑 Удалить у клиента" после автоответа — draft здесь хранит
    // не текст на утверждение, а connectionId/messageId уже отправленного сообщения.
    try {
      await deleteBusinessMessages(draft.connectionId, [draft.messageId]);
      deleteDraft(draftId);
      await editMessageText(cardChatId, cardMessageId, `${cardText}\n\n🗑 Удалено у клиента.`);
      await answerCallbackQuery(query.id, "Удалено");
    } catch (err) {
      console.error(`[bot] Ошибка удаления автоответа #${draftId}:`, err.message);
      await answerCallbackQuery(query.id, "Не удалось удалить, см. логи");
    }
  } else {
    await answerCallbackQuery(query.id);
  }
}

// Личный чат с ботом (не Business API) — сюда прилетают карточки черновиков
// на утверждение (см. handleCallbackQuery) и сюда же можно писать боту
// напрямую как ассистенту (код, тексты, правки) — отдельная история
// и отдельная персона (assistant-persona.md), не путать с автоответчиком.
// Закрытый вход: чужие сообщения молча отбрасываются.
const SECRETARY_CHAT_PREFIX = "secretary:";

function formatTaskLine(t) {
  const due = t.dueAt ? ` (напоминание: ${new Date(t.dueAt).toLocaleString("ru-RU")})` : "";
  return `#${t.id} ${t.text}${due}`;
}

async function handleTodoCommand(chatId, text) {
  const rest = text.slice("/todo".length).trim();

  if (!rest || rest === "list") {
    const tasks = listOpenTasks();
    await sendMessage(chatId, tasks.length ? tasks.map(formatTaskLine).join("\n") : "Открытых задач нет.");
    return;
  }

  const doneMatch = rest.match(/^done\s+(\d+)$/i);
  if (doneMatch) {
    const ok = completeTask(doneMatch[1]);
    await sendMessage(chatId, ok ? `#${doneMatch[1]} закрыта.` : "Такой задачи нет.");
    return;
  }

  const id = createTask(rest);
  await sendMessage(chatId, `Добавил #${id}: ${rest}`);
}

// Только относительные сроки (30m / 2h / 1d) — без парсинга дат/таймзон, надёжнее.
function parseRemind(text) {
  const match = text.match(/^\/remind\s+(\d+)([mhd])\s+(.+)$/is);
  if (!match) return null;
  const [, amountStr, unit, body] = match;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return { dueAt: Date.now() + Number(amountStr) * unitMs, text: body.trim() };
}

async function handleRemindCommand(chatId, text) {
  const parsed = parseRemind(text);
  if (!parsed) {
    await sendMessage(chatId, "Формат: /remind 30m текст  /remind 2h текст  /remind 1d текст");
    return;
  }
  const id = createTask(parsed.text, parsed.dueAt);
  await sendMessage(chatId, `Напомню #${id} в ${new Date(parsed.dueAt).toLocaleString("ru-RU")}.`);
}

function formatAgo(ts) {
  if (!ts) return "нет данных";
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

async function handleChatsCommand(chatId) {
  const summaries = listChatSummaries();
  if (!summaries.length) {
    await sendMessage(
      chatId,
      "Бот пока не видел ни одного чата. Он видит только сообщения, пришедшие после подключения к Telegram Business, " +
        "и хранит их в data/ — если этот том не сохраняется между деплоями, память пропадает.\n\n" +
        "Старую переписку можно загрузить: Telegram Desktop → чат → ⋮ → Экспорт истории → формат JSON → отправь result.json сюда."
    );
    return;
  }
  const kindIcon = { work: "💼", personal: "👤" };
  const lines = summaries.map((s) => {
    const who = s.lastRole === "customer" ? "он(а)" : "ты";
    const name = s.title || "без имени";
    return `${kindIcon[s.kind] || "•"} ${name} #${s.chatId} — ${s.count} сообщ., последнее ${formatAgo(s.lastTs)} (${who}): ${s.lastText.replace(/\s+/g, " ").slice(0, 60)}`;
  });
  const text = `Все чаты, которые видел бот (${summaries.length}):\n\n${lines.join("\n")}\n\nСпроси Рафаэля про любой из них по имени — он сам прочитает переписку.`;
  for (const chunk of splitForTelegram(text)) await sendMessage(chatId, chunk);
}

// /chat <id или имя> — то же, что спросить Рафаэля: он сам подгрузит переписку.
async function handleChatCommand(ownerChatId, text) {
  const target = text.replace(/^\/chat\s*/i, "").trim();
  if (!target) {
    await sendMessage(ownerChatId, "Формат: /chat <имя или id> — список в /chats");
    return;
  }
  await secretaryTurn(ownerChatId, `Прочитай переписку с «${target}» и коротко скажи, с кем она и на чём остановились.`);
}

const CONTENT_CHAT_PREFIX = "content:";
const DAY_KICKOFF = "[СИСТЕМА] Начни сбор материала на сегодня.";

function formatRecentPosts() {
  const posts = getRecentPosts();
  if (!posts.length) return "Последние посты Untra.dev: данных пока нет.";
  const lines = posts.map((p, i) => {
    const date = new Date(p.ts).toLocaleDateString("ru-RU");
    return `${i + 1}. (${date}) ${p.text.replace(/\s+/g, " ").slice(0, 200)}`;
  });
  return `Последние посты Untra.dev (от старых к новым):\n${lines.join("\n")}`;
}

// Ручной пост в Untra.dev (бот — админ канала, поэтому получает channel_post).
// Посты, опубликованные самим ботом, сюда не приходят — они пишутся при ✅.
function isUntraChannel(chat) {
  const id = String(config.untraChannelId);
  return String(chat.id) === id || (chat.username && `@${chat.username}`.toLowerCase() === id.toLowerCase());
}

function handleChannelPost(post) {
  const text = post.text || post.caption;
  if (!text || !isUntraChannel(post.chat)) return;
  addRecentPost(text);
  console.log("[bot] Записал ручной пост Untra.dev для баланса рубрик.");
}

function postButtons(draftId) {
  return [
    [
      { text: "✅ Запостить", callback_data: `d:s:${draftId}` },
      { text: "🗑 Не постить", callback_data: `d:x:${draftId}` },
    ],
  ];
}

async function runContentTurn(chatId, incomingText, images = []) {
  const key = `${CONTENT_CHAT_PREFIX}${chatId}`;
  setContentMode(chatId, true); // продлеваем /day — выключится сам после паузы
  const stopTyping = keepTyping(chatId);

  try {
    const { raw, ready, message, untra, vlog, notes } = await contentTurn({
      sessionKey: key,
      text: incomingText,
      images,
      recentPostsText: formatRecentPosts(),
    });
    stopTyping();
    if (!raw) {
      console.warn("[bot] Пустой ответ от контент-агента.");
      return;
    }

    if (!ready) {
      await sendFormatted(chatId, message || raw);
      return;
    }

    if (!untra.length && !vlog) {
      // Маркер есть, но секции не распознались — не теряем текст молча.
      await sendMessage(chatId, raw);
      return;
    }

    // Посты — простым текстом: так же они уйдут в канал.
    for (const post of untra) {
      const draftId = createDraft({ kind: "channel_post", channelId: config.untraChannelId, channelLabel: "Untra.dev", text: post });
      await sendMessageWithButtons(chatId, `📝 Untra.dev:\n\n${post}`, postButtons(draftId));
    }
    if (vlog) {
      const draftId = createDraft({ kind: "channel_post", channelId: config.vlogChannelId, channelLabel: "Untra dev — vlog", text: vlog });
      await sendMessageWithButtons(chatId, `📝 Untra dev — vlog:\n\n${vlog}`, postButtons(draftId));
    }

    // Подсказка к посту (угол, визуал, запасной хук) — после самих постов,
    // в канал не публикуется.
    if (notes) {
      await sendFormatted(chatId, `💡 К посту:\n${notes}`);
    }
  } catch (err) {
    stopTyping();
    console.error("[bot] Ошибка контент-агента:", err.message);
    await sendMessage(chatId, "Не смог обработать — ошибка на моей стороне, см. логи.");
  }
}

async function stopDay(chatId) {
  setContentMode(chatId, false);
  clearSession(`${CONTENT_CHAT_PREFIX}${chatId}`);
  await sendMessage(chatId, "Вышел из разбора дня. Дальше отвечает Рафаэль.");
}

async function handleDayCommand(chatId, text) {
  const arg = text.slice("/day".length).trim().toLowerCase();

  if (arg === "stop") {
    await stopDay(chatId);
    return;
  }

  clearHistory(`${CONTENT_CHAT_PREFIX}${chatId}`);
  clearSession(`${CONTENT_CHAT_PREFIX}${chatId}`);
  setContentMode(chatId, true);
  await sendMessage(chatId, `📅 Разбор дня. Выйти — /stop (или сам выключится через ${Math.round(config.dayIdleMs / 3_600_000)} ч тишины).`);
  await runContentTurn(chatId, DAY_KICKOFF);
}

// --- Память (/remember, /memory, /forget) ---
async function handleMemoryCommand(chatId, text) {
  const [cmd, ...restParts] = text.trim().split(/\s+/);
  const rest = restParts.join(" ").trim();
  const command = cmd.toLowerCase();

  if (command === "/remember") {
    if (!rest) {
      await sendMessage(chatId, "Формат: /remember факт. Например: /remember Бахтиёр из «Малибу» хочет каталог к 1 ноября");
      return;
    }
    const n = addMemory(rest);
    await sendMessage(chatId, `Запомнил (#${n}). Рафаэль и /day будут это знать.`);
    return;
  }
  if (command === "/forget") {
    const index = Number(rest) - 1;
    await sendMessage(chatId, removeMemory(index) ? `Забыл #${rest}.` : "Такого номера нет. Список — /memory");
    return;
  }
  // /memory
  const facts = listMemory();
  await sendMessage(chatId, facts.length ? `Что я помню:\n${memoryText()}\n\nУдалить — /forget номер` : "Пока ничего. Добавить — /remember факт");
}

// --- Импорт экспорта Telegram Desktop (result.json) ---
function isJsonDocument(msg) {
  const doc = msg.document;
  return Boolean(doc && (/json/i.test(doc.mime_type || "") || /\.json$/i.test(doc.file_name || "")));
}

async function handleImport(chatId, doc) {
  if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
    await sendMessage(chatId, "Файл больше 20 МБ — Telegram не отдаёт такие ботам. Экспортируй отдельные чаты или без медиа (только JSON).");
    return;
  }
  const stopTyping = keepTyping(chatId);
  try {
    const file = await getFile(doc.file_id);
    const json = JSON.parse((await downloadFile(file.file_path)).toString("utf8"));
    const chats = parseTelegramExport(json, config.ownerTelegramId, config.chatStoreLimit);
    stopTyping();
    if (!chats.length) {
      await sendMessage(chatId, "В файле не нашёл личных чатов. Нужен экспорт Telegram Desktop в формате JSON (result.json).");
      return;
    }
    const lines = [];
    for (const c of chats) {
      const total = importChatHistory(c.chatId, { title: c.title, messages: c.messages });
      for (const m of c.messages) if (m.role === "azizhon" && m.text.length < 300 && !m.text.startsWith("[")) addStyleSample(m.text);
      lines.push(`• ${c.title || "без имени"} #${c.chatId}: +${c.messages.length} (всего ${total})`);
    }
    const text = `Загрузил ${chats.length} чат(ов):\n${lines.join("\n")}\n\nТеперь можно спрашивать Рафаэля про эти переписки.`;
    for (const chunk of splitForTelegram(text)) await sendMessage(chatId, chunk);
  } catch (err) {
    stopTyping();
    console.error("[bot] Ошибка импорта:", err.message);
    await sendMessage(chatId, `Не смог разобрать файл: ${err instanceof SyntaxError ? "это не JSON" : err.message}.`);
  }
}

async function checkReminders() {
  const due = getDueUnnotifiedTasks(Date.now());
  for (const t of due) {
    await sendMessage(config.ownerTelegramId, `⏰ Напоминание #${t.id}: ${t.text}`);
    markTaskNotified(t.id);
  }
}

// Ответ Рафаэля: markdown-lite -> HTML Telegram, длинное — несколькими сообщениями.
async function sendFormatted(chatId, md) {
  for (const chunk of splitForTelegram(md)) {
    await sendHtmlMessage(chatId, toTelegramHtml(chunk), chunk);
  }
}

async function handleAutoCommand(chatId, text) {
  const arg = text.slice("/auto".length).trim().toLowerCase();

  if (arg === "on") {
    setAutoSendToggle(true);
    await sendMessage(chatId, "Автоответы включены.");
    return;
  }
  if (arg === "off") {
    setAutoSendToggle(false);
    await sendMessage(chatId, "Автоответы выключены.");
    return;
  }

  const active = isAutoSendActive();
  const count = getTodayAutoSendCount();
  const dryRunNote = config.dryRun ? "\n🧪 DRY_RUN включён — реальных отправок клиентам сейчас нет." : "";
  await sendMessage(
    chatId,
    `Автоответы сейчас ${active ? "включены ✅" : "выключены ⛔"}.\nОтправлено автоматически сегодня: ${count}.\n\n/auto on — включить, /auto off — выключить.${dryRunNote}`
  );
}

// «печатает…» держится ~5 секунд — обновляем, пока думает модель.
function keepTyping(chatId) {
  sendChatAction(chatId).catch(() => {});
  const timer = setInterval(() => sendChatAction(chatId).catch(() => {}), 4500);
  return () => clearInterval(timer);
}

async function secretaryTurn(chatId, text, images = []) {
  const chatKey = `${SECRETARY_CHAT_PREFIX}${chatId}`;
  const fallbackHistory = getHistory(chatKey);
  pushHistory(chatKey, "azizhon", text);
  const stopTyping = keepTyping(chatId);
  try {
    const reply = await raphaelTurn({ chatKey, text, images, fallbackHistory });
    stopTyping();
    if (!reply) {
      console.warn("[bot] Пустой ответ от Рафаэля, пропускаю отправку.");
      return;
    }
    await sendFormatted(chatId, reply);
    pushHistory(chatKey, "assistant", reply);
  } catch (err) {
    stopTyping();
    console.error(`[bot] Ошибка Рафаэля:`, err.message);
    await sendMessage(chatId, "Не смог ответить — ошибка на моей стороне, см. логи.");
  }
}

async function handlePersonalMessage(msg) {
  if (msg.chat.type !== "private" || msg.from?.id !== config.ownerTelegramId) {
    console.warn(`[bot] Личное сообщение от чужого id ${msg.from?.id}, игнорирую.`);
    return;
  }
  const chatId = msg.chat.id;

  if (isJsonDocument(msg)) {
    await handleImport(chatId, msg.document);
    return;
  }

  // Голосовое -> текст, фото/видео -> картинки для Claude. Команды голосом
  // не распознаются (расшифровка не начинается с "/"), это нормально.
  let text = msg.text || msg.caption || "";
  let images = [];
  if (hasMedia(msg)) {
    const stopTyping = keepTyping(chatId);
    try {
      const media = await extractMedia(msg);
      stopTyping();
      if (media) {
        text = media.text;
        images = media.images;
        // Сырую расшифровку показываем сразу — видно, что именно распозналось.
        if (media.kind === "voice") {
          await sendMessage(chatId, `🎤 ${media.transcript || "(ничего не распознал)"}`);
          if (!media.transcript) return;
        } else if (media.kind === "video" || media.kind === "video_note") {
          await sendMessage(chatId, `🎥 Звук: ${media.transcript || "(речи нет или не распознал)"}`);
        }
      }
    } catch (err) {
      stopTyping();
      console.error("[bot] Не смог разобрать медиа от Азизхона:", err.message);
      const why = err instanceof MediaError ? err.message : "ошибка на моей стороне, см. логи";
      await sendMessage(chatId, `Не смог разобрать вложение: ${why}.`);
      if (!msg.caption) return;
    }
  }
  if (!text) return;

  console.log(`[bot] Сообщение от Азизхона: ${text.slice(0, 80)}`);
  const command = text.startsWith("/") ? text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "") : null;

  switch (command) {
    case "/start":
      await sendMessage(chatId, `Рафаэль на связи. Пиши как есть — текстом, голосом, скрином. Вот все команды:\n\n${buildHelpText()}`);
      return;
    case "/help":
      await sendMessage(chatId, buildHelpText());
      return;
    case "/auto":
      await handleAutoCommand(chatId, text);
      return;
    case "/todo":
      await handleTodoCommand(chatId, text);
      return;
    case "/remind":
      await handleRemindCommand(chatId, text);
      return;
    case "/chats":
      await handleChatsCommand(chatId);
      return;
    case "/chat":
      await handleChatCommand(chatId, text);
      return;
    case "/day":
      await handleDayCommand(chatId, text);
      return;
    case "/stop":
      await stopDay(chatId);
      return;
    case "/new":
      resetRaphael(`${SECRETARY_CHAT_PREFIX}${chatId}`);
      clearHistory(`${SECRETARY_CHAT_PREFIX}${chatId}`);
      await sendMessage(chatId, "Начали с чистого листа. Долгая память (/memory) и чаты остались.");
      return;
    case "/remember":
    case "/memory":
    case "/forget":
      await handleMemoryCommand(chatId, text);
      return;
    default:
      break;
  }

  if (isContentModeActive(chatId)) {
    await runContentTurn(chatId, text, images);
    return;
  }

  await secretaryTurn(chatId, text, images);
}

// Личный чат обрабатываем в фоне (по очереди внутри чата), чтобы долгий
// ответ Рафаэля с поиском в интернете не держал long polling и клиентов.
const personalQueues = new Map();
function enqueuePersonal(msg) {
  const key = msg.chat.id;
  const prev = personalQueues.get(key) || Promise.resolve();
  const next = prev
    .then(() => handlePersonalMessage(msg))
    .catch((err) => console.error("[bot] Ошибка обработки личного сообщения:", err.message))
    .finally(() => {
      if (personalQueues.get(key) === next) personalQueues.delete(key);
    });
  personalQueues.set(key, next);
}

async function pollLoop() {
  let offset = getLastUpdateId() ? getLastUpdateId() + 1 : undefined;

  while (true) {
    await checkReminders();
    await processAutoSendQueue();

    let updates;
    try {
      updates = await getUpdates(offset);
    } catch (err) {
      console.error("[bot] Ошибка getUpdates, повтор через 5с:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      setLastUpdateId(update.update_id);

      const msg = update.business_message || update.edited_business_message;
      if (msg) {
        await handleBusinessMessage(msg);
      } else if (update.message) {
        enqueuePersonal(update.message);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      } else if (update.channel_post) {
        handleChannelPost(update.channel_post);
      }
    }
  }
}

// Регистрируем команды в меню Telegram только для личного чата с владельцем
// (scope: chat) — чужим, кто напишет боту напрямую, список команд не покажется.
// Если вызов упадёт (например, сеть недоступна) — не мешаем боту стартовать.
async function registerCommands() {
  try {
    await setMyCommands(MENU_COMMANDS, { type: "chat", chat_id: config.ownerTelegramId });
  } catch (err) {
    console.error("[bot] Не удалось зарегистрировать команды (setMyCommands):", err.message);
  }
}

registerCommands();

pollLoop().catch((err) => {
  console.error("[bot] Критическая ошибка, бот остановлен:", err);
  process.exit(1);
});
