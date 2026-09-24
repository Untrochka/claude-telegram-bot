import { config } from "./config.js";
import {
  getUpdates,
  getBusinessConnection,
  sendBusinessMessage,
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
} from "./telegram.js";
import {
  getLastUpdateId,
  setLastUpdateId,
  getHistory,
  pushHistory,
  getCachedOwnerId,
  cacheOwnerId,
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
} from "./state.js";
import { generateReply, generateSecretaryReply, generateContentReply } from "./claudeClient.js";

console.log(`[bot] Запуск. Режим Claude: ${config.claudeMode}`);

async function resolveOwnerId(connectionId) {
  const cached = getCachedOwnerId(connectionId);
  if (cached) return cached;
  const conn = await getBusinessConnection(connectionId);
  const ownerId = conn.user?.id;
  if (ownerId) cacheOwnerId(connectionId, ownerId);
  return ownerId;
}

async function handleBusinessMessage(msg) {
  const connectionId = msg.business_connection_id;
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;

  if (!connectionId || !text) return; // не текстовое сообщение или что-то нестандартное — пропускаем

  const ownerId = await resolveOwnerId(connectionId);

  if (!ownerId || ownerId !== config.ownerTelegramId) {
    console.warn(
      `[bot] Business-подключение ${connectionId} принадлежит чужому аккаунту (${ownerId}), игнорирую.`
    );
    return;
  }

  if (msg.from?.id === ownerId) {
    // Азизхон сам ответил в этом чате вручную — просто запоминаем для контекста, не отвечаем.
    pushHistory(chatId, "azizhon", text);
    console.log(`[bot] Азизхон ответил лично в чате ${chatId}, бот молчит.`);
    return;
  }

  console.log(`[bot] Новое сообщение в чате ${chatId}: ${text.slice(0, 80)}`);
  pushHistory(chatId, "customer", text);

  try {
    const history = getHistory(chatId);
    const { urgency, text: reply } = await generateReply(history.slice(0, -1), text);
    if (!reply) {
      console.warn("[bot] Пустой ответ от Claude, пропускаю отправку.");
      return;
    }
    const draftId = createDraft({ kind: "business", connectionId, chatId, text: reply });
    const urgencyLabel = { urgent: "🔴 Срочно", spam: "⚪ Спам/не по делу" }[urgency] || "🟡 Обычное";
    const preview = `${urgencyLabel}\n💬 Клиент (чат ${chatId}):\n${text}\n\n✏️ Черновик ответа:\n${reply}`;
    await sendMessageWithButtons(config.ownerTelegramId, preview, [
      [
        { text: "✅ Отправить", callback_data: `d:s:${draftId}` },
        { text: "🗑 Не отправлять", callback_data: `d:x:${draftId}` },
      ],
    ]);
    console.log(`[bot] Черновик #${draftId} на утверждение (чат ${chatId}).`);
  } catch (err) {
    console.error(`[bot] Ошибка генерации ответа в чате ${chatId}:`, err.message);
  }
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
        console.log(`[bot] Пост #${draftId} опубликован в ${draft.channelLabel} (${draft.channelId}).`);
      } else {
        await sendBusinessMessage(draft.connectionId, draft.chatId, draft.text);
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
    await sendMessage(chatId, "Активных клиентских чатов нет.");
    return;
  }
  const lines = summaries.map((s) => {
    const who = s.lastRole === "customer" ? "клиент" : "ты";
    return `#${s.chatId} — ${s.count} сообщ., последнее (${who}, ${formatAgo(s.lastTs)}): ${s.lastText.slice(0, 60)}`;
  });
  await sendMessage(chatId, lines.join("\n"));
}

async function handleChatCommand(ownerChatId, text) {
  const targetId = text.match(/^\/chat\s+(\S+)/i)?.[1];
  if (!targetId) {
    await sendMessage(ownerChatId, "Формат: /chat <id> — id смотри в /chats");
    return;
  }
  const history = getHistory(targetId);
  if (!history.length) {
    await sendMessage(ownerChatId, `Чат #${targetId} не найден или пуст.`);
    return;
  }
  const transcript = history.map((m) => `${m.role === "customer" ? "Клиент" : "Азизхон"}: ${m.text}`).join("\n");
  pushHistory(
    `${SECRETARY_CHAT_PREFIX}${ownerChatId}`,
    "context",
    `Переписка с клиентом #${targetId}:\n${transcript}`
  );
  await sendMessage(ownerChatId, `Загрузил переписку с #${targetId} (${history.length} сообщ.) в контекст. Спрашивай.`);
}

const CONTENT_CHAT_PREFIX = "content:";
const DAY_KICKOFF = "[СИСТЕМА] Начни сбор материала на сегодня.";

async function runContentTurn(chatId, incomingText) {
  const key = `${CONTENT_CHAT_PREFIX}${chatId}`;
  pushHistory(key, "azizhon", incomingText);

  try {
    const history = getHistory(key);
    const { raw, ready, message, untra, vlog } = await generateContentReply(history.slice(0, -1), incomingText);
    if (!raw) {
      console.warn("[bot] Пустой ответ от контент-агента.");
      return;
    }
    pushHistory(key, "assistant", raw);

    if (!ready) {
      await sendMessage(chatId, message || raw);
      return;
    }

    if (!untra && !vlog) {
      // Маркер есть, но секции не распознались — не теряем текст молча.
      await sendMessage(chatId, raw);
      return;
    }

    if (untra) {
      const draftId = createDraft({
        kind: "channel_post",
        channelId: config.untraChannelId,
        channelLabel: "Untra.dev",
        text: untra,
      });
      await sendMessageWithButtons(chatId, `📝 Untra.dev:\n\n${untra}`, [
        [
          { text: "✅ Запостить", callback_data: `d:s:${draftId}` },
          { text: "🗑 Не постить", callback_data: `d:x:${draftId}` },
        ],
      ]);
    }

    if (vlog) {
      const draftId = createDraft({
        kind: "channel_post",
        channelId: config.vlogChannelId,
        channelLabel: "Untra dev — vlog",
        text: vlog,
      });
      await sendMessageWithButtons(chatId, `📝 Untra dev — vlog:\n\n${vlog}`, [
        [
          { text: "✅ Запостить", callback_data: `d:s:${draftId}` },
          { text: "🗑 Не постить", callback_data: `d:x:${draftId}` },
        ],
      ]);
    }
  } catch (err) {
    console.error("[bot] Ошибка контент-агента:", err.message);
    await sendMessage(chatId, "Не смог обработать — ошибка на моей стороне, см. логи.");
  }
}

async function handleDayCommand(chatId, text) {
  const arg = text.slice("/day".length).trim().toLowerCase();

  if (arg === "stop") {
    setContentMode(chatId, false);
    await sendMessage(chatId, "Вышел из режима дневного разбора.");
    return;
  }

  clearHistory(`${CONTENT_CHAT_PREFIX}${chatId}`);
  setContentMode(chatId, true);
  await runContentTurn(chatId, DAY_KICKOFF);
}

async function checkReminders() {
  const due = getDueUnnotifiedTasks(Date.now());
  for (const t of due) {
    await sendMessage(config.ownerTelegramId, `⏰ Напоминание #${t.id}: ${t.text}`);
    markTaskNotified(t.id);
  }
}

async function handlePersonalMessage(msg) {
  if (msg.chat.type !== "private" || msg.from?.id !== config.ownerTelegramId) {
    console.warn(`[bot] Личное сообщение от чужого id ${msg.from?.id}, игнорирую.`);
    return;
  }

  const text = msg.text || msg.caption;
  if (!text) return;

  console.log(`[bot] Секретарь: сообщение от Азизхона: ${text.slice(0, 80)}`);

  if (text === "/start") {
    await sendMessage(
      msg.chat.id,
      "Секретарь на связи. Пиши как есть — код, тексты, вопросы. Команды: /todo, /remind, /chats, /chat <id>, /day (/day stop)."
    );
    return;
  }

  if (text.startsWith("/todo")) {
    await handleTodoCommand(msg.chat.id, text);
    return;
  }

  if (text.startsWith("/remind")) {
    await handleRemindCommand(msg.chat.id, text);
    return;
  }

  if (text.startsWith("/chats")) {
    await handleChatsCommand(msg.chat.id);
    return;
  }

  if (/^\/chat\s+/i.test(text)) {
    await handleChatCommand(msg.chat.id, text);
    return;
  }

  if (text.startsWith("/day")) {
    await handleDayCommand(msg.chat.id, text);
    return;
  }

  if (isContentModeActive(msg.chat.id)) {
    await runContentTurn(msg.chat.id, text);
    return;
  }

  const chatKey = `${SECRETARY_CHAT_PREFIX}${msg.chat.id}`;
  pushHistory(chatKey, "azizhon", text);

  try {
    const history = getHistory(chatKey);
    const reply = await generateSecretaryReply(history.slice(0, -1), text);
    if (!reply) {
      console.warn("[bot] Пустой ответ от секретаря, пропускаю отправку.");
      return;
    }
    await sendMessage(msg.chat.id, reply);
    pushHistory(chatKey, "assistant", reply);
  } catch (err) {
    console.error(`[bot] Ошибка секретарского ответа:`, err.message);
    await sendMessage(msg.chat.id, "Не смог ответить — ошибка на моей стороне, см. логи.");
  }
}

async function pollLoop() {
  let offset = getLastUpdateId() ? getLastUpdateId() + 1 : undefined;

  while (true) {
    await checkReminders();

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
        await handlePersonalMessage(update.message);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      }
    }
  }
}

pollLoop().catch((err) => {
  console.error("[bot] Критическая ошибка, бот остановлен:", err);
  process.exit(1);
});
