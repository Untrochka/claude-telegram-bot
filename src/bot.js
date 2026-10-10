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
  setOwnerLogger,
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
  getAgentValue,
  setAgentValue,
  updateDraft,
  findDraftByCardMessage,
  addBotNote,
} from "./state.js";
import { generateReply } from "./claudeClient.js";
import { raphaelTurn, resetRaphael, contentTurn, memoryText, visibleRaphaelText } from "./raphael.js";
import { createStreamer } from "./stream.js";
import { modelsText, setEffort, resetEfforts, getEffort, ROLES, EFFORTS } from "./models.js";
import { STRATEGIES, readStrategy, strategiesListText, addStrategyNote, removeStrategyNote } from "./strategies.js";
import { startMtproto, isMtprotoReady } from "./mtproto.js";
import {
  runDiscovery,
  pollWatchlist,
  processCommentQueue,
  handleCommentCallback,
  applyCommentRewrite,
  isCancelText,
  cancelOrOfferDelete,
  latestCancellableId,
  watchListText,
  addWatchManual,
  removeWatch,
  commentsStatusText,
  resetAutoWatch,
} from "./comments.js";
import { runRedditDigest, handleRedditCallback, applyRedditRewrite } from "./reddit.js";
import { plannerTick, handlePlanCallback, morningBriefText } from "./planner.js";
import { applyJarvisOps } from "./jarvis.js";
import { applyStudyOps, handleStudyMessage } from "./study.js";
import { watcherTick } from "./watcher.js";
import { applyDraftRewrite, clientRulesText, clientCardText, clientButtons, postButtons } from "./rewrite.js";
import { localRoute, logEvent, LOCAL_ACK, memoryForAgents, findCommentByText, botStateText } from "./team.js";
import { setMemoryProvider, getWatch } from "./comments.js";
import { setPlannerMemoryProvider } from "./planner.js";
import { parseTelegramExport } from "./importer.js";
import { getTemplate } from "./templates.js";
import { checkPrices } from "./prices.js";
import { MENU_COMMANDS, buildHelpText, cmdBtn, askBtn, grid, askPrompt, QUICK_MENU } from "./commands.js";
import { extractMedia, hasMedia, MediaError } from "./media.js";
import { toTelegramHtml, splitForTelegram } from "./format.js";
import { startMcpServer } from "./untra/mcp.js";
import { backupTick, restoreIfEmpty } from "./untra/backup.js";
import { liveTick } from "./untra/live.js";
import { readSystemFile, writeSystemFile, crmLog } from "./untra/store.js";
import { setEveningPlanRunner } from "./planner.js";
import { runScanForOwner, sendCrmBatchCard, sendQueueCard, handleCrmBatchCallback, handleSendQueueCallback, stopQueue, DEFAULT_FOLDER } from "./outreach.js";

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
  const card = { kind: "business", connectionId, chatId, text: replyText, intent, customerText, extraLine: `${urgencyLabelFor(intent)}\n${extraLine}` };
  const draftId = createDraft(card);
  // ✏️ или ответ (reply) на карточку — переписать; правка запоминается для следующих ответов.
  const msg = await sendMessageWithButtons(config.ownerTelegramId, clientCardText(card), clientButtons(draftId));
  updateDraft(draftId, { cardMessageId: msg?.message_id });
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
        if (config.clientDrafts) await notifyNonTextMessage(chatId, msg, err instanceof MediaError ? err.message : "ошибка, см. логи");
        return;
      }
    }
  }

  if (!incoming) {
    if (config.clientDrafts) await notifyNonTextMessage(chatId, msg);
    return;
  }

  console.log(`[bot] Новое сообщение в чате ${chatId}${mediaKind ? ` (${mediaKind})` : ""}: ${incoming.slice(0, 80)}`);
  pushHistory(chatId, "customer", incoming);
  // Черновики и автоответы выключены (CLIENT_DRAFTS=true включает): только пишем в историю.
  if (!config.clientDrafts) return;
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
    rules: clientRulesText(),
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

// --- Кнопки команд (m:…) ---
// Нажатие = как будто Мастер написал команду сам; «?» — спросить недостающий текст.
async function askForInput(chatId, command) {
  setAgentValue("pendingCommand", { cmd: command, ts: Date.now() });
  await sendMessageWithButtons(chatId, askPrompt(command), [[cmdBtn("✖ Отмена", "!cancel")]]);
}

async function handleMenuCallback(query, command) {
  const chatId = query.message.chat.id;
  if (command === "!cancel") {
    setAgentValue("pendingCommand", null);
    await answerCallbackQuery(query.id, "Отменил").catch(() => {});
    return;
  }
  if (command.startsWith("?")) {
    await askForInput(chatId, command.slice(1));
    await answerCallbackQuery(query.id, "Жду текст").catch(() => {});
    return;
  }
  await answerCallbackQuery(query.id).catch(() => {});
  enqueuePersonal({ chat: { id: chatId, type: "private" }, from: { id: config.ownerTelegramId }, text: command });
}

// Кнопки агента: c — комментарии, r — Reddit, p — напоминания, sn — правка стратегии.
async function handleAgentCallback(query, prefix, action, id) {
  let answer = null;
  try {
    if (prefix === "c") answer = await handleCommentCallback(query, action, id);
    else if (prefix === "r") answer = await handleRedditCallback(query, action, id);
    else if (prefix === "p") {
      const res = await handlePlanCallback(query, action, id);
      if (res?.startDay) {
        await answerCallbackQuery(query.id, "Начинаем /day");
        enqueuePersonal({ chat: { id: query.message.chat.id, type: "private" }, from: { id: config.ownerTelegramId }, text: "/day" });
        return;
      }
      answer = res;
    } else if (prefix === "sn") answer = await handleStrategyNoteCallback(query, action, id);
    else if (prefix === "uw" || prefix === "cl") answer = await handleUntraCallback(query, prefix, action, id);
    else if (prefix === "cb") answer = await handleCrmBatchCallback(query, action, id);
    else if (prefix === "sq") answer = await handleSendQueueCallback(query, action, id);
  } catch (err) {
    console.error(`[bot] Ошибка кнопки ${prefix}:${action}:`, err.message);
    answer = "Ошибка, см. логи";
  }
  await answerCallbackQuery(query.id, typeof answer === "string" ? answer.slice(0, 190) : undefined).catch(() => {});
}

async function sendStrategyNoteCard(chatId, note) {
  const id = createDraft({ kind: "strategy_note", name: note.name, text: note.text });
  await sendMessageWithButtons(chatId, `📌 Правка стратегии «${STRATEGIES[note.name]}»:
${note.text}`, [
    [
      { text: "✅ Сохранить", callback_data: `sn:y:${id}` },
      { text: "🗑 Не надо", callback_data: `sn:n:${id}` },
    ],
  ]);
}

// --- Изменения системы untra и CRM от Джарвиса: только после ✅ Мастера ---
async function sendUntraWriteCard(chatId, w) {
  let before = "";
  try {
    before = readSystemFile(w.path);
  } catch {}
  const id = createDraft({ kind: "untra_write", path: w.path, content: w.content });
  const preview = w.content.length > 3000 ? w.content.slice(0, 3000) + "\n…" : w.content;
  const sizeNote = before ? `было ${before.length} → станет ${w.content.length} символов` : "новый файл";
  await sendMessageWithButtons(chatId, `📝 Джарвис хочет изменить ${w.path} (${sizeNote}):\n\n${preview}`, [
    [
      { text: "✅ Записать", callback_data: `uw:y:${id}` },
      { text: "🗑 Не надо", callback_data: `uw:n:${id}` },
    ],
  ]);
}

async function sendCrmLogCard(chatId, c) {
  const id = createDraft({ kind: "crm_log", event: c });
  const who = c.id || c.business || c.contact || "новый лид";
  await sendMessageWithButtons(chatId, `🗂 Запись в CRM: ${c.action} — ${who}${c.summary ? `\n${c.summary}` : ""}`, [
    [
      { text: "✅ Записать", callback_data: `cl:y:${id}` },
      { text: "🗑 Не надо", callback_data: `cl:n:${id}` },
    ],
  ]);
}

async function handleUntraCallback(query, prefix, action, id) {
  const d = getDraft(id);
  if (!d) return "Уже не актуально.";
  deleteDraft(id);
  const text = (query.message.text || "").slice(0, 3500);
  if (action !== "y") {
    await editMessageText(query.message.chat.id, query.message.message_id, `${text}\n\n🗑 Не менял.`);
    return "Ок";
  }
  try {
    if (prefix === "uw") writeSystemFile(d.path, d.content, "raphael (✅ Мастер)");
    else crmLog(d.event, "raphael (✅ Мастер)");
    logEvent?.(`Мастер подтвердил: ${prefix === "uw" ? `файл ${d.path}` : `CRM ${d.event.action}`}`);
    await editMessageText(query.message.chat.id, query.message.message_id, `${text}\n\n✅ Записано.`);
    return "Записал";
  } catch (e) {
    await editMessageText(query.message.chat.id, query.message.message_id, `${text}\n\n⚠️ Не получилось: ${e.message}`);
    return "Ошибка";
  }
}

async function handleStrategyNoteCallback(query, action, id) {
  const d = getDraft(id);
  if (!d) return "Уже не актуально.";
  deleteDraft(id);
  const text = query.message.text || "";
  if (action === "y") {
    addStrategyNote(d.name, d.text);
    await editMessageText(query.message.chat.id, query.message.message_id, `${text}\n\n✅ Сохранено. Посмотреть: /strategy ${d.name}`);
    return "Сохранил";
  }
  await editMessageText(query.message.chat.id, query.message.message_id, `${text}\n\n🗑 Не сохранял.`);
  return "Ок";
}

async function handleCallbackQuery(query) {
  if (query.from?.id !== config.ownerTelegramId) {
    await answerCallbackQuery(query.id, "Не твоё.");
    return;
  }

  if ((query.data || "").startsWith("m:")) {
    await handleMenuCallback(query, query.data.slice(2));
    return;
  }
  const [prefix, action, draftId] = (query.data || "").split(":");
  if (prefix !== "d") {
    await handleAgentCallback(query, prefix, action, draftId);
    return;
  }
  const draft = getDraft(draftId);
  if (!draft) {
    await answerCallbackQuery(query.id, "Черновик уже не актуален.");
    return;
  }

  const cardChatId = query.message.chat.id;
  const cardMessageId = query.message.message_id;
  const cardText = query.message.text || "";

  const isPost = draft.kind === "channel_post";

  if (action === "re") {
    setAgentValue("pendingRewrite", { kind: "draft", draftId, ts: Date.now() });
    await sendMessage(cardChatId, "Напиши, что поменять (например «проще и без ИИ-шных фраз»). Или «текст: …» — поставлю твой вариант. Можно и просто ответить (reply) на карточку.");
    await answerCallbackQuery(query.id, "Жду правку");
    return;
  }

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
  const due = t.dueAt ? ` (напоминание: ${new Date(t.dueAt).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" })})` : "";
  return `#${t.id} ${t.text}${due}`;
}

async function handleTodoCommand(chatId, text) {
  const rest = text.slice("/todo".length).trim();

  if (!rest || rest === "list") {
    const tasks = listOpenTasks();
    const done = tasks.slice(0, 12).map((t) => cmdBtn(`✅ #${t.id}`, `/todo done ${t.id}`));
    await sendMessageWithButtons(
      chatId,
      tasks.length ? `${tasks.map(formatTaskLine).join("\n")}\n\nЗакрыть — нажми ✅ с номером.` : "Открытых задач нет.",
      [...grid(done, 4), [askBtn("➕ Задача", "/todo"), askBtn("⏰ Напоминание", "/remind")]]
    );
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
  const rest = text.replace(/^\/remind\s*/i, "").trim();
  if (!rest) {
    await askForInput(chatId, "/remind");
    return;
  }
  // Понимаем и «2 часа позвонить», «30 минут …» — через тот же разбор, что «напомни через …».
  let parsed = parseRemind(text);
  if (!parsed) {
    const r = localRoute(`напомни через ${rest.replace(/^через\s+/i, "")}`);
    if (r?.action === "remind") parsed = parseRemind(`/remind ${r.arg}`);
  }
  if (!parsed) {
    await sendMessageWithButtons(chatId, "Не понял срок. Пиши так: 30m текст, 2h текст, 1d текст (или «2 часа текст»).", [[askBtn("⏰ Ещё раз", "/remind")]]);
    return;
  }
  const id = createTask(parsed.text, parsed.dueAt);
  await sendMessage(chatId, `Напомню #${id} в ${new Date(parsed.dueAt).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" })}.`);
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
  const text = `Все чаты, которые видел бот (${summaries.length}):\n\n${lines.join("\n")}\n\nНажми на чат — Джарвис прочитает переписку и скажет, на чём остановились.`;
  const chunks = splitForTelegram(text);
  for (const chunk of chunks.slice(0, -1)) await sendMessage(chatId, chunk);
  const open = summaries.slice(0, 12).map((s) => cmdBtn(`${kindIcon[s.kind] || "•"} ${(s.title || String(s.chatId)).slice(0, 22)}`, `/chat ${s.chatId}`));
  await sendMessageWithButtons(chatId, chunks[chunks.length - 1], grid(open, 2));
}

// /chat <id или имя> — то же, что спросить Джарвиса: он сам подгрузит переписку.
async function handleChatCommand(ownerChatId, text) {
  const target = text.replace(/^\/chat\s*/i, "").trim();
  if (!target) {
    await handleChatsCommand(ownerChatId);
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

async function runContentTurn(chatId, incomingText, images = []) {
  const key = `${CONTENT_CHAT_PREFIX}${chatId}`;
  setContentMode(chatId, true); // продлеваем /day — выключится сам после паузы
  const stopTyping = keepTyping(chatId);
  // Стримим только обычные реплики интервью; готовые посты (READY_TO_POST)
  // придут карточками, их по кускам не показываем.
  const streamer = createStreamer(chatId, {
    transform: (t) => ("READY_TO_POST".startsWith(t.trim().slice(0, 13)) || t.trim().startsWith("READY_TO_POST") ? null : t),
  });

  try {
    const { raw, ready, message, untra, vlog, notes } = await contentTurn({
      sessionKey: key,
      text: incomingText,
      images,
      recentPostsText: formatRecentPosts(),
      onDelta: (t) => streamer.update(t),
    });
    stopTyping();
    if (!raw) {
      await streamer.discard();
      console.warn("[bot] Пустой ответ от контент-агента.");
      return;
    }

    if (!ready) {
      await streamer.finish(message || raw);
      return;
    }
    await streamer.discard();

    if (!untra.length && !vlog) {
      // Маркер есть, но секции не распознались — не теряем текст молча.
      await sendMessage(chatId, raw);
      return;
    }

    // Посты — простым текстом: так же они уйдут в канал.
    for (const post of untra) {
      const draftId = createDraft({ kind: "channel_post", channelId: config.untraChannelId, channelLabel: "Untra.dev", text: post });
      const m = await sendMessageWithButtons(chatId, `📝 Untra.dev:\n\n${post}`, postButtons(draftId));
      updateDraft(draftId, { cardMessageId: m?.message_id });
    }
    if (vlog) {
      const draftId = createDraft({ kind: "channel_post", channelId: config.vlogChannelId, channelLabel: "Untra dev — vlog", text: vlog });
      const m = await sendMessageWithButtons(chatId, `📝 Untra dev — vlog:\n\n${vlog}`, postButtons(draftId));
      updateDraft(draftId, { cardMessageId: m?.message_id });
    }

    // Подсказка к посту (угол, визуал, запасной хук) — после самих постов,
    // в канал не публикуется.
    if (notes) {
      await sendFormatted(chatId, `💡 К посту:\n${notes}`);
    }
  } catch (err) {
    stopTyping();
    await streamer.discard();
    console.error("[bot] Ошибка контент-агента:", err.message);
    await sendMessage(chatId, "Не смог обработать — ошибка на моей стороне, см. логи.");
  }
}

async function stopDay(chatId) {
  setContentMode(chatId, false);
  clearSession(`${CONTENT_CHAT_PREFIX}${chatId}`);
  await sendMessage(chatId, "Вышел из разбора дня. Дальше отвечает Джарвис.");
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
      await askForInput(chatId, "/remember");
      return;
    }
    const n = addMemory(rest);
    await sendMessage(chatId, `Запомнил (#${n}). Джарвис и /day будут это знать.`);
    return;
  }
  if (command === "/forget" && rest) {
    const index = Number(rest) - 1;
    // Номера сдвигаются после удаления — сразу показываем свежий список с новыми кнопками.
    await sendMessage(chatId, removeMemory(index) ? `Забыл #${rest}. Номера обновились:` : "Такого номера нет.");
  }
  // /memory
  const facts = listMemory();
  const forget = facts.slice(0, 16).map((_, i) => cmdBtn(`🗑 ${i + 1}`, `/forget ${i + 1}`));
  await sendMessageWithButtons(
    chatId,
    facts.length ? `Что я помню:\n${memoryText()}\n\nУдалить — 🗑 с номером.` : "Пока ничего не помню.",
    [...grid(forget, 4), [askBtn("➕ Запомнить", "/remember")]]
  );
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
    const text = `Загрузил ${chats.length} чат(ов):\n${lines.join("\n")}\n\nТеперь можно спрашивать Джарвиса про эти переписки.`;
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

// Ответ Джарвиса: markdown-lite -> HTML Telegram, длинное — несколькими сообщениями.
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
  await sendMessageWithButtons(
    chatId,
    `Автоответы сейчас ${active ? "включены ✅" : "выключены ⛔"}.\nОтправлено автоматически сегодня: ${count}.${dryRunNote}`,
    [[active ? cmdBtn("⛔ Выключить", "/auto off") : cmdBtn("✅ Включить", "/auto on")]]
  );
}

// «печатает…» держится ~5 секунд — обновляем, пока думает модель.
function keepTyping(chatId) {
  sendChatAction(chatId).catch(() => {});
  const timer = setInterval(() => sendChatAction(chatId).catch(() => {}), 4500);
  return () => clearInterval(timer);
}

// Действия, которые запускает Джарвис ([[ACTION: …]]) или локальный роутер
// простых фраз (без Claude). Отправки клиентам здесь нет — только кнопкой.
async function runRaphaelAction(chatId, { name, arg = "" }) {
  try {
    switch (name) {
      case "watch_find":
        return handleWatchCommand(chatId, "/watch find");
      case "watch_reset":
        return handleWatchCommand(chatId, "/watch reset");
      case "watch_add":
        return arg && handleWatchCommand(chatId, `/watch add ${arg}`);
      case "watch_remove":
        return arg && handleWatchCommand(chatId, `/watch remove ${arg}`);
      case "comments_check":
        return handleCommentsCommand(chatId, "/comments check");
      case "comments_on":
        return handleCommentsCommand(chatId, "/comments on");
      case "comments_off":
        return handleCommentsCommand(chatId, "/comments off");
      case "reddit":
        return handleRedditCommand(chatId);
      case "plan":
        return sendMessage(chatId, morningBriefText());
      case "todo_list":
        return handleTodoCommand(chatId, "/todo");
      case "todo_add":
        return arg && handleTodoCommand(chatId, `/todo ${arg}`);
      case "todo_done":
        return arg && handleTodoCommand(chatId, `/todo done ${arg.replace(/^#/, "")}`);
      case "remind":
        return arg && handleRemindCommand(chatId, `/remind ${arg}`);
      case "remember":
        if (!arg) return;
        addMemory(arg);
        return sendMessage(chatId, `🧠 Запомнил: ${arg}`);
      case "auto_on":
        return handleAutoCommand(chatId, "/auto on");
      case "auto_off":
        return handleAutoCommand(chatId, "/auto off");
      case "model":
        return arg && handleModelCommand(chatId, `/model ${arg}`);
      case "day_start":
        return handleDayCommand(chatId, "/day");
      case "memory_list":
        return handleMemoryCommand(chatId, "/memory");
      case "status":
        return sendMessage(chatId, `Состояние бота, Мастер:\n${botStateText(chatId)}`);
      case "comment_cancel":
      case "comment_delete": {
        // Удаление — только кнопкой Мастера: здесь максимум присылаем кнопку.
        const id = arg.replace(/^#/, "").trim() || latestCancellableId();
        if (!id) return sendMessage(chatId, "Нечего отменять: в очереди пусто, недавно ничего не уходило.");
        const r = await cancelOrOfferDelete(id);
        return r && sendMessage(chatId, r);
      }
      default:
        return;
    }
  } catch (err) {
    console.error(`[bot] Действие ${name} упало:`, err.message);
  }
}

// Настройки Джарвиса из маркера [[JARVIS_SET]]: сразу, без карточки — но только в ходе личного чата
// Мастера и только если в ходе не читались чужие тексты (иначе это путь для prompt injection).
async function applyJarvisSets(chatId, sets, { blocked = false } = {}) {
  if (!sets.length) return;
  if (blocked) {
    await sendMessage(chatId, "⚠️ Настройки не менял: в этом ходе я читал чужую переписку или ход начал сам бот. Попроси отдельным сообщением.");
    return;
  }
  for (const ops of sets) {
    if (!ops) {
      await sendMessage(chatId, "⚠️ Настройки не изменил: маркер с неверным JSON.");
      continue;
    }
    try {
      const res = applyJarvisOps(ops);
      if (res.ok) {
        addBotNote(`Настройки Джарвиса изменены: ${res.summary}`);
        await sendMessage(chatId, `✅ Записал: ${res.summary}`);
      } else await sendMessage(chatId, `⚠️ Настройки не изменил:\n${res.errors.map((e) => `• ${e}`).join("\n")}`);
    } catch (err) {
      console.error("[bot] JARVIS_SET:", err.message);
      await sendMessage(chatId, `⚠️ Настройки не изменил: ${err.message}`);
    }
  }
}

// Учёба из маркера [[STUDY]]: те же ограничения, что у JARVIS_SET (только личный ход Мастера, без чужих текстов).
async function applyStudySets(chatId, sets, { blocked = false } = {}) {
  if (!sets.length) return;
  if (blocked) {
    await sendMessage(chatId, "⚠️ Учёбу не менял: в этом ходе я читал чужую переписку или ход начал сам бот. Попроси отдельным сообщением.");
    return;
  }
  for (const ops of sets) {
    if (!ops) {
      await sendMessage(chatId, "⚠️ Учёбу не изменил: маркер с неверным JSON.");
      continue;
    }
    try {
      const res = applyStudyOps(ops);
      if (res.ok) {
        addBotNote(`Учёба изменена: ${res.summary}`);
        await sendMessage(chatId, `✅ ${res.summary}`);
        for (const n of res.notices) await sendMessage(chatId, n);
      } else await sendMessage(chatId, `⚠️ Учёбу не изменил:\n${res.errors.map((e) => `• ${e}`).join("\n")}`);
    } catch (err) {
      console.error("[bot] STUDY:", err.message);
      await sendMessage(chatId, `⚠️ Учёбу не изменил: ${err.message}`);
    }
  }
}

// opts.auto — ход начат ботом, а не Мастером (настройки по маркеру не применяем).
async function secretaryTurn(chatId, text, images = [], opts = {}) {
  const chatKey = `${SECRETARY_CHAT_PREFIX}${chatId}`;
  const fallbackHistory = getHistory(chatKey);
  pushHistory(chatKey, "azizhon", text);
  const stopTyping = keepTyping(chatId);
  const streamer = createStreamer(chatId, { transform: visibleRaphaelText });
  try {
    const { text: reply, notes, rewrites, actions, writes, crmLogs, crmBatches, sendQueues, jarvisSets, studySets, foreignLoaded } = await raphaelTurn({
      chatKey,
      text,
      images,
      ownerChatId: chatId,
      fallbackHistory,
      onDelta: (t) => streamer.update(t),
      onStatus: (s) => streamer.status(s),
    });
    stopTyping();
    if (reply) {
      await streamer.finish(reply);
      pushHistory(chatKey, "assistant", reply);
    } else {
      await streamer.discard();
      if (!rewrites?.length && !notes?.length) console.warn("[bot] Пустой ответ от Джарвиса, пропускаю отправку.");
    }
    for (const note of notes || []) await sendStrategyNoteCard(chatId, note);
    for (const w of writes || []) await sendUntraWriteCard(chatId, w);
    for (const c of crmLogs || []) await sendCrmLogCard(chatId, c);
    for (const b of crmBatches || []) await sendCrmBatchCard(chatId, b);
    for (const q of sendQueues || []) await sendQueueCard(chatId, q);
    await applyJarvisSets(chatId, jarvisSets || [], { blocked: opts.auto || foreignLoaded });
    await applyStudySets(chatId, studySets || [], { blocked: opts.auto || foreignLoaded });
    for (const rw of rewrites || []) {
      const ok = await applyDraftRewrite(rw.draftId, rw.instruction);
      if (!ok) await sendMessage(chatId, `Черновик #${rw.draftId} уже не актуален.`);
    }
    for (const a of actions || []) await runRaphaelAction(chatId, a);
  } catch (err) {
    stopTyping();
    await streamer.discard();
    console.error(`[bot] Ошибка Джарвиса:`, err.message);
    await sendMessage(chatId, "Не смог ответить — ошибка на моей стороне, см. логи.");
  }
}

// --- Агент: /model, /strategy, /watch, /comments, /reddit, /plan ---
async function handleModelCommand(chatId, text) {
  const args = text.split(/\s+/).slice(1).map((a) => a.toLowerCase());
  if (!args.length) {
    const roleBtns = Object.keys(ROLES).map((r) => cmdBtn(`${r}: ${getEffort(r)}`, `/model ${r}`));
    await sendMessageWithButtons(chatId, `${modelsText()}\n\nНажми на роль, чтобы поменять effort.`, [
      ...grid(roleBtns, 2),
      [cmdBtn("Все сразу", "/model all"), cmdBtn("↩️ По умолчанию", "/model reset")],
    ]);
    return;
  }
  if (args[0] === "reset") {
    resetEfforts();
    await sendMessage(chatId, `Вернул effort по умолчанию.\n\n${modelsText()}`);
    return;
  }
  const [role, effort] = args;
  if ((ROLES[role] || role === "all") && !effort) {
    const cur = role === "all" ? "" : ` (сейчас ${getEffort(role)})`;
    await sendMessageWithButtons(chatId, `Effort для ${role === "all" ? "всех ролей" : role}${cur}:`, grid(EFFORTS.map((e) => cmdBtn(e, `/model ${role} ${e}`)), 3));
    return;
  }
  if (role === "all" && EFFORTS.includes(effort)) {
    for (const r of Object.keys(ROLES)) setEffort(r, effort);
    await sendMessage(chatId, `Поставил effort ${effort} везде.\n\n${modelsText()}`);
    return;
  }
  if (!ROLES[role] || !EFFORTS.includes(effort)) {
    await sendMessage(chatId, `Не понял. Роли: ${Object.keys(ROLES).join(", ")} (или all). Effort: ${EFFORTS.join(", ")}.\nПример: /model writer high`);
    return;
  }
  setEffort(role, effort);
  await sendMessage(chatId, `Ок: ${role} → effort ${effort}.`);
}

async function handleStrategyCommand(chatId, text) {
  const rest = text.replace(/^\/strategy\s*/i, "").trim();
  if (!rest) {
    await sendMessageWithButtons(chatId, strategiesListText(), grid(Object.entries(STRATEGIES).map(([n, label]) => cmdBtn(label, `/strategy ${n}`)), 2));
    return;
  }
  const m = rest.match(/^(\w+)\s*(?:([+-])\s*([\s\S]*))?$/);
  const name = m?.[1]?.toLowerCase();
  if (!name || !STRATEGIES[name]) {
    await sendMessage(chatId, `Нет такой стратегии. ${strategiesListText()}`);
    return;
  }
  if (m[2] === "+" && m[3]?.trim()) {
    addStrategyNote(name, m[3]);
    await sendMessage(chatId, `Добавил правку в «${STRATEGIES[name]}».`);
    return;
  }
  if (m[2] === "-") {
    const ok = removeStrategyNote(name, Number(m[3]) - 1);
    await sendMessage(chatId, ok ? "Удалил правку." : "Нет правки с таким номером.");
    return;
  }
  const chunks = splitForTelegram(readStrategy(name));
  for (const chunk of chunks.slice(0, -1)) await sendMessage(chatId, chunk);
  await sendMessageWithButtons(chatId, chunks[chunks.length - 1], [[askBtn("➕ Добавить правку", `/strategy ${name} +`), cmdBtn("↩️ Все стратегии", "/strategy")]]);
}

// Фоновые задачи агента не должны держать long polling.
const agentJobs = new Set();
function runAgentJob(name, fn) {
  if (agentJobs.has(name)) return false;
  agentJobs.add(name);
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error(`[agent] ${name} упал:`, err.message))
    .finally(() => agentJobs.delete(name));
  return true;
}

async function handleWatchCommand(chatId, text) {
  const [, sub, arg] = text.trim().split(/\s+/);
  if (!isMtprotoReady()) {
    await sendMessage(chatId, watchListText());
    return;
  }
  if (sub === "add" && arg) {
    try {
      await sendMessage(chatId, await addWatchManual(arg));
    } catch (err) {
      await sendMessage(chatId, `Не смог добавить: ${err.message}`);
    }
    return;
  }
  if ((sub === "remove" || sub === "rm") && arg) {
    await sendMessage(chatId, removeWatch(arg));
    return;
  }
  if (sub === "add" && !arg) {
    await askForInput(chatId, "/watch add");
    return;
  }
  if (sub === "find" || sub === "reset") {
    const cleared = sub === "reset" ? resetAutoWatch() : 0;
    const started = runAgentJob("discovery", async () => {
      const res = await runDiscovery({ force: true });
      const added = res?.added?.length ? res.added.map((u) => `@${u}`).join(", ") : "никого";
      await sendMessage(chatId, `🔎 Поиск каналов закончен. Добавил: ${added}.${res?.removed?.length ? ` Убрал: ${res.removed.map((u) => `@${u}`).join(", ")}.` : ""}${res?.note ? `\n${res.note}` : ""}\n\n${watchListText()}`);
    });
    await sendMessage(chatId, started ? `${cleared ? `Убрал ${cleared} найденных раньше каналов. ` : ""}Ищу каналы (СНГ на русском и англоязычные) — займёт 3–6 минут: паузы между запросами, чтобы Telegram не ругался. Список пришлю сам…` : "Поиск уже идёт.");
    return;
  }
  const chunks = splitForTelegram(watchListText());
  for (const chunk of chunks.slice(0, -1)) await sendMessage(chatId, chunk);
  const removeBtns = Object.keys(getWatch()).slice(0, 20).map((u) => cmdBtn(`✖ @${u}`.slice(0, 30), `/watch remove ${u}`));
  await sendMessageWithButtons(chatId, `${chunks[chunks.length - 1]}${removeBtns.length ? "\n\n✖ — убрать канал из списка." : ""}`, [
    [cmdBtn("🔍 Найти ещё", "/watch find"), askBtn("➕ Добавить", "/watch add")],
    [cmdBtn("♻️ Пересобрать заново", "/watch reset")],
    ...grid(removeBtns, 2),
  ]);
}

async function handleCommentsCommand(chatId, text) {
  const arg = text.split(/\s+/)[1]?.toLowerCase();
  if (arg === "on" || arg === "off") {
    setAgentValue("commentsOn", arg === "on");
    await sendMessage(chatId, arg === "on" ? "Агент комментариев включён." : "Агент комментариев выключен.");
    return;
  }
  if (arg === "check") {
    const started = runAgentJob("poll", async () => {
      const res = await pollWatchlist({ force: true });
      await sendMessage(chatId, res?.drafted ? `Готово: черновиков ${res.drafted}.` : `Новых подходящих постов нет.${res?.note ? ` (${res.note})` : ""}`);
    });
    await sendMessage(chatId, started ? "Проверяю каналы…" : "Проверка уже идёт.");
    return;
  }
  const on = getAgentValue("commentsOn", true);
  await sendMessageWithButtons(chatId, commentsStatusText(), [
    [cmdBtn("🔄 Проверить сейчас", "/comments check"), on ? cmdBtn("⏸ Выключить", "/comments off") : cmdBtn("▶️ Включить", "/comments on")],
    [cmdBtn("📡 Каналы", "/watch")],
  ]);
}

async function handleRedditCommand(chatId) {
  const started = runAgentJob("reddit", async () => {
    const n = await runRedditDigest({ maxDrafts: 3 });
    if (!n) await sendMessage(chatId, "Свежих подходящих вопросов на Reddit не нашёл.");
  });
  await sendMessage(chatId, started ? "Смотрю Reddit…" : "Уже смотрю.");
}

function isQuestionText(text) {
  const t = text.trim();
  return /\?\s*$/.test(t) || /^(почему|зачем|что|как|какой|какая|актуал|уверен|норм|а если|а почему|разве)(\s|$|,)/i.test(t);
}

const DRAFT_KIND_LABEL = { business: "ответ клиенту", channel_post: "пост в канал", comment: "комментарий в Telegram", reddit: "ответ на Reddit" };

// Правка черновика комментария/ответа после кнопки ✏️. -> true если сообщение ушло туда.
async function consumePendingRewrite(chatId, text) {
  const pending = getAgentValue("pendingRewrite", null);
  if (!pending || text.startsWith("/") || Date.now() - pending.ts > 15 * 60_000) return false;
  // Вопрос («почему так?», «а это норм?») — не правка: отдаём Джарвису, слот не трогаем.
  if (isQuestionText(text) && !isCancelText(text)) return false;
  setAgentValue("pendingRewrite", null);
  const stopTyping = keepTyping(chatId);
  try {
    if (pending.kind === "draft") return await applyDraftRewrite(pending.draftId, text);
    if (pending.kind === "comment") return await applyCommentRewrite(pending, text);
    if (pending.kind === "reddit") return await applyRedditRewrite(pending, text);
    return false;
  } finally {
    stopTyping();
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
  // После кнопки «➕ …» следующее сообщение — это текст к команде.
  const pendingCmd = getAgentValue("pendingCommand", null);
  if (pendingCmd) {
    setAgentValue("pendingCommand", null);
    const newerRewrite = (getAgentValue("pendingRewrite", null)?.ts || 0) > pendingCmd.ts;
    if (!newerRewrite && !images.length && !text.startsWith("/") && Date.now() - pendingCmd.ts < 10 * 60_000) {
      if (isCancelText(text)) {
        await sendMessage(chatId, "Ок, отменил.");
        return;
      }
      text = `${pendingCmd.cmd} ${text}`;
    }
  }
  if (!images.length && (await consumePendingRewrite(chatId, text))) return;

  // Ответ (reply) на сообщение бота: на карточку черновика — это правка черновика;
  // на любое другое — даём Джарвису контекст, на что именно ответил Мастер.
  const replied = msg.reply_to_message;
  // «отмени», «бро отмен», «стоп» — отмена отправки комментария, без Claude.
  if (!images.length && isCancelText(text)) {
    let target = null;
    if (replied) {
      const rid = findDraftByCardMessage(replied.message_id);
      const rc = findCommentByText((replied.text || replied.caption || "").slice(0, 1500));
      target = rc ? rc.id : rid && getDraft(rid)?.kind === "comment" ? rid : null;
    } else {
      target = latestCancellableId();
    }
    if (target) {
      logEvent(`Мастер: ${text.slice(0, 60)} → отмена комментария #${target}`);
      const r = await cancelOrOfferDelete(target);
      if (r) await sendMessage(chatId, r);
      return;
    }
  }
  if (replied && !text.startsWith("/")) {
    const draftId = findDraftByCardMessage(replied.message_id);
    // Вопрос к карточке («актуален?», «?») — это не правка, отдаём Джарвису с контекстом.
    const isQuestion = isQuestionText(text);
    if (draftId && !isQuestion) {
      const stopTyping = keepTyping(chatId);
      try {
        if (await applyDraftRewrite(draftId, text)) return;
      } finally {
        stopTyping();
      }
    }
    const quoted = (replied.text || replied.caption || "").slice(0, 1500);
    const fromBot = Boolean(replied.from?.is_bot);
    const comment = findCommentByText(quoted);
    const card = draftId ? getDraft(draftId) : null;
    const ctx = comment
      ? `[Мастер отвечает на карточку комментария #${comment.id} (@${comment.username}, ${comment.status}). Пост: «${(comment.postText || "").slice(0, 600)}» Комментарий: «${comment.text}»]`
      : card
        ? `[Мастер отвечает на карточку черновика #${draftId} (${DRAFT_KIND_LABEL[card.kind] || card.kind}${card.customerText ? `; клиент написал: «${card.customerText.slice(0, 500)}»` : ""}). Текст черновика: «${(card.text || "").slice(0, 1200)}». Переписать — [[REWRITE: ${draftId} | …]].]`
        : quoted
        ? fromBot
          ? `(Ответ на твоё сообщение: "${quoted}")`
          : `[Мастер отвечает на своё сообщение:\n«${quoted}»]`
        : "";
    if (ctx) text = `${ctx}\n\n${text}`;
  } else if ((msg.forward_origin || msg.forward_from) && !images.length) {
    // Пересланная карточка — даём Джарвису понять, что это за коммент.
    const comment = findCommentByText(text);
    if (comment) {
      text = `[Мастер переслал карточку комментария #${comment.id} (@${comment.username}, ${comment.status}). Пост: «${(comment.postText || "").slice(0, 600)}» Комментарий: «${comment.text}»]\n\nЧто скажешь про этот комментарий?`;
    }
  }
  const command = text.startsWith("/") ? text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "") : null;
  if (command) logEvent(`Мастер: ${text.slice(0, 120)}`);

  switch (command) {
    case "/start":
      for (const chunk of splitForTelegram(`Джарвис на связи. Пиши как есть — текстом, голосом, скрином. Вот все команды:\n\n${buildHelpText()}`)) await sendMessage(chatId, chunk);
      await sendMessageWithButtons(chatId, "Быстрые кнопки — жми, печатать не надо:", QUICK_MENU);
      return;
    case "/help":
      for (const chunk of splitForTelegram(buildHelpText())) await sendMessage(chatId, chunk);
      await sendMessageWithButtons(chatId, "Быстрые кнопки — жми, печатать не надо:", QUICK_MENU);
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
    case "/model":
      await handleModelCommand(chatId, text);
      return;
    case "/strategy":
      await handleStrategyCommand(chatId, text);
      return;
    case "/watch":
      await handleWatchCommand(chatId, text);
      return;
    case "/comments":
      await handleCommentsCommand(chatId, text);
      return;
    case "/reddit":
      await handleRedditCommand(chatId);
      return;
    case "/plan":
      await sendMessage(chatId, morningBriefText());
      return;
    case "/scan_clients": {
      const folder = text.split(/\s+/).slice(1).join(" ").trim() || DEFAULT_FOLDER;
      await sendMessage(chatId, `🔎 Проверяю папку «${folder}»…`);
      for (const chunk of splitForTelegram(await runScanForOwner(chatId, folder))) await sendMessage(chatId, chunk);
      return;
    }
    case "/stop_queue":
      await sendMessage(chatId, stopQueue() ? "⛔ Останавливаю очередь — итог пришлю." : "Очереди сейчас нет.");
      return;
    default:
      break;
  }

  if (isContentModeActive(chatId)) {
    await runContentTurn(chatId, text, images);
    return;
  }

  // Простые фразы — сами, без Claude (экономим лимиты). Джарвис увидит это в журнале.
  const route = !images.length && !msg.reply_to_message ? localRoute(text) : null;
  if (route) {
    logEvent(`Мастер: ${text.slice(0, 120)}`);
    console.log(`[bot] Локально без Claude: ${route.action}`);
    if (LOCAL_ACK[route.action]) await sendMessage(chatId, LOCAL_ACK[route.action]);
    await runRaphaelAction(chatId, { name: route.action, arg: route.arg });
    return;
  }

  // Отчёт об учёбе и вопрос «сколько займёт» — Groq + код, без Claude. Всё сомнительное идёт Джарвису.
  if (!images.length && !hasMedia(msg) && !msg.reply_to_message && text.length <= 400) {
    let study = null;
    try {
      study = await handleStudyMessage(text);
    } catch (err) {
      console.warn("[bot] Учёба локально не вышла, отдаю Джарвису:", err.message);
    }
    if (study) {
      const chatKey = `${SECRETARY_CHAT_PREFIX}${chatId}`;
      pushHistory(chatKey, "azizhon", text);
      pushHistory(chatKey, "assistant", study.reply);
      logEvent(`Мастер: ${text.slice(0, 120)}`);
      logEvent(`Бот (учёба, без Claude): ${study.reply.replace(/\s+/g, " ").slice(0, 160)}`);
      console.log(`[bot] Учёба локально без Claude: ${study.kind}`);
      await sendMessage(chatId, study.reply);
      return;
    }
  }

  await secretaryTurn(chatId, text, images);
}

// Личный чат обрабатываем в фоне (по очереди внутри чата), чтобы долгий
// ответ Джарвиса с поиском в интернете не держал long polling и клиентов.
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

// Агент: напоминания, поиск каналов, мониторинг постов, очередь отправки
// комментариев. Всё в фоне — long polling клиентов не ждёт модель.
function agentTick() {
  try {
    plannerTick();
    runAgentJob("watcher", watcherTick);
    runAgentJob("commentQueue", processCommentQueue);
    if (isMtprotoReady()) {
      runAgentJob("discovery", () => runDiscovery());
      // Не читаем каналы параллельно с поиском — меньше шансов на FLOOD_WAIT.
      if (!agentJobs.has("discovery")) runAgentJob("poll", () => pollWatchlist());
    }
  } catch (err) {
    console.error("[agent] tick:", err.message);
  }
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
// 20:45 — Джарвис сам готовит план на завтра; NOW.md меняется только после ✅.
setEveningPlanRunner(() =>
  secretaryTurn(
    config.ownerTelegramId,
    "[Автозадача 20:45] Подготовь план на завтра. Прочитай [[UNTRA: state/NOW.md]], [[CRM: тёплые]] и [[CRM: статус]], учти моё расписание и приоритеты. " +
      "Потом коротко напиши мне план (что сделать мне самому, что делают ИИ, кому напомнить, сколько новых и в каких сегментах) " +
      "и предложи обновлённый state/NOW.md целиком через UNTRA_WRITE, с разделом «## План на <завтрашняя дата>» в начале.",
    [],
    { auto: true }
  )
);
setOwnerLogger((text) => addBotNote(text));
// Общая память: комментарии и адаптации постов знают, что Мастер просил запомнить.
setMemoryProvider(memoryForAgents);
setPlannerMemoryProvider(memoryForAgents);
startMtproto().catch((err) => console.error("[mtproto] Старт:", err.message));
// Тик агента независимо от long polling (getUpdates ждёт до 30 с).
setInterval(agentTick, 20_000);
// Система untra: дверь для Claude/GPT (MCP) и ночной бэкап в GitHub.
restoreIfEmpty()
  .catch((e) => console.error("[backup] восстановление:", e.message.replace(/https:\/\/[^@]+@/g, "https://***@")))
  .finally(() => {
    liveTick(console.log);
    startMcpServer();
  });
setInterval(() => liveTick(console.log), 30_000);
setInterval(() => backupTick(console.log), 60_000);

pollLoop().catch((err) => {
  console.error("[bot] Критическая ошибка, бот остановлен:", err);
  process.exit(1);
});
