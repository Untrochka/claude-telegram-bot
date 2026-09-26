import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function loadState() {
  try {
    const raw = fs.readFileSync(config.statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      lastUpdateId: 0,
      chats: {},
      connections: {},
      drafts: {},
      nextDraftId: 1,
      tasks: {},
      nextTaskId: 1,
    };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));
}

let  state = loadState();

export function getLastUpdateId() {
  return state.lastUpdateId || 0;
}

export function setLastUpdateId(id) {
  state.lastUpdateId = id;
  saveState(state);
}

export function getHistory(chatId) {
  return state.chats[chatId]?.history || [];
}

export function pushHistory(chatId, role, text) {
  if (!state.chats[chatId]) state.chats[chatId] = { history: [] };
  state.chats[chatId].history.push({ role, text, ts: Date.now() });
  // Клиентские чаты храним длинно (Рафаэль анализирует переписку целиком),
  // служебные secretary:/content: — коротко, как раньше.
  const isClientChat = !String(chatId).includes(":");
  const limit = isClientChat ? config.chatStoreLimit : config.historyLimit;
  state.chats[chatId].history = state.chats[chatId].history.slice(-limit);
  // "azizhon" в чате без префикса (не secretary:/content:) — это реальный
  // клиентский чат, в котором он сам ответил. Флаг переживает обрезку
  // истории и нужен для защиты автоотправки (см. canAutoSendNow ниже).
  if (role === "azizhon" && !String(chatId).includes(":")) {
    state.chats[chatId].azizhonEverReplied = true;
    state.chats[chatId].lastAzizhonTs = Date.now();
  }
  saveState(state);
}

export function clearHistory(chatId) {
  if (state.chats[chatId]) state.chats[chatId].history = [];
  saveState(state);
}

// Флаг "сейчас идёт /day интервью" — пока true, личные сообщения идут
// в контент-агента, а не в обычный секретарский чат.
// Хранится время последней активности: если /day забыли выключить, через
// config.dayIdleMs он выключается сам. Старый формат (просто true) = выключен.
export function isContentModeActive(chatId) {
  const mode = state.contentMode?.[chatId];
  return Boolean(mode?.active && Date.now() - mode.ts < config.dayIdleMs);
}

export function setContentMode(chatId, active) {
  state.contentMode = state.contentMode || {};
  state.contentMode[chatId] = { active, ts: Date.now() };
  saveState(state);
}

// Сводка по всем клиентским чатам для /chats — без секретарской переписки.
export function listChatSummaries() {
  return Object.entries(state.chats || {})
    .filter(([key]) => !key.includes(":")) // secretary:/content: — не клиентские чаты
    .map(([chatId, data]) => {
      const history = data.history || [];
      const last = history[history.length - 1];
      return {
        chatId,
        title: data.title || "",
        kind: data.kind || "unknown",
        count: history.length,
        lastText: last?.text || "",
        lastRole: last?.role || "",
        lastTs: last?.ts || 0,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

// Кэш business_connection_id -> user_id владельца аккаунта (Азизхона),
// чтобы не отвечать на его же собственные сообщения в том же чате.
export function getCachedOwnerId(connectionId) {
  return state.connections[connectionId];
}

export function cacheOwnerId(connectionId, ownerId) {
  state.connections[connectionId] = ownerId;
  saveState(state);
}

// Черновики ответов, ожидающие подтверждения владельца (✅/🗑 в личке).
export function createDraft(data) {
  state.drafts = state.drafts || {};
  state.nextDraftId = state.nextDraftId || 1;
  const id = String(state.nextDraftId);
  state.nextDraftId += 1;
  state.drafts[id] = data;
  saveState(state);
  return id;
}

export function getDraft(id) {
  return state.drafts?.[id];
}

export function deleteDraft(id) {
  if (state.drafts) delete state.drafts[id];
  saveState(state);
}

// Задачи/напоминания секретаря (/todo, /remind).
export function createTask(text, dueAt = null) {
  state.tasks = state.tasks || {};
  state.nextTaskId = state.nextTaskId || 1;
  const id = String(state.nextTaskId);
  state.nextTaskId += 1;
  state.tasks[id] = { text, dueAt, done: false, notified: false, createdAt: Date.now() };
  saveState(state);
  return id;
}

export function listOpenTasks() {
  return Object.entries(state.tasks || {})
    .filter(([, t]) => !t.done)
    .map(([id, t]) => ({ id, ...t }));
}

export function completeTask(id) {
  if (!state.tasks?.[id]) return false;
  state.tasks[id].done = true;
  saveState(state);
  return true;
}

export function getDueUnnotifiedTasks(now) {
  return Object.entries(state.tasks || {})
    .filter(([, t]) => !t.done && t.dueAt && t.dueAt <= now && !t.notified)
    .map(([id, t]) => ({ id, ...t }));
}

export function markTaskNotified(id) {
  if (!state.tasks?.[id]) return;
  state.tasks[id].notified = true;
  saveState(state);
}

// --- Автоответы: защита от ошибок (см. CLAUDE_CODE_TASK.md п. 3.4) ---

// Флаг появился позже истории: для старых чатов смотрим ещё и на историю.
export function hasAzizhonEverReplied(chatId) {
  const chat = state.chats[chatId];
  return Boolean(chat?.azizhonEverReplied || chat?.history?.some((m) => m.role === "azizhon"));
}

export function getLastAzizhonTs(chatId) {
  return state.chats[chatId]?.lastAzizhonTs || 0;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getAutoSendRecord(chatId) {
  return state.chats[chatId]?.autoSends || { sentIntents: [], dailyDate: null, dailyCount: 0 };
}

// Каждый intent — максимум один автоответ на чат, максимум 2 автоответа
// на чат в сутки.
export function canAutoSendNow(chatId, intent) {
  const record = getAutoSendRecord(chatId);
  const dailyCount = record.dailyDate === todayKey() ? record.dailyCount : 0;
  return !record.sentIntents.includes(intent) && dailyCount < 2;
}

export function recordAutoSend(chatId, intent) {
  if (!state.chats[chatId]) state.chats[chatId] = { history: [] };
  const chat = state.chats[chatId];
  chat.autoSends = chat.autoSends || { sentIntents: [], dailyDate: null, dailyCount: 0 };
  const today = todayKey();
  if (chat.autoSends.dailyDate !== today) {
    chat.autoSends.dailyDate = today;
    chat.autoSends.dailyCount = 0;
  }
  chat.autoSends.sentIntents.push(intent);
  chat.autoSends.dailyCount += 1;
  saveState(state);
}

// Сумма автоответов за сегодня по всем чатам — для команды /auto.
export function getTodayAutoSendCount() {
  const today = todayKey();
  return Object.values(state.chats || {}).reduce((sum, chat) => {
    if (chat.autoSends?.dailyDate === today) return sum + chat.autoSends.dailyCount;
    return sum;
  }, 0);
}

// Ручной переключатель /auto on|off. undefined — не переопределялся,
// используется дефолт из .env (config.autoSendEnabled).
export function getAutoSendToggle() {
  return state.autoSendToggle;
}

export function setAutoSendToggle(value) {
  state.autoSendToggle = value;
  saveState(state);
}

// Право business-подключения удалять отправленные сообщения
// (BusinessBotRights.can_delete_sent_messages) — от этого зависит, показывать
// ли кнопку "🗑 Удалить у клиента" после автоответа.
export function cacheConnectionRights(connectionId, canDelete) {
  state.connectionRights = state.connectionRights || {};
  state.connectionRights[connectionId] = Boolean(canDelete);
  saveState(state);
}

export function getConnectionRights(connectionId) {
  return Boolean(state.connectionRights?.[connectionId]);
}

// --- Последние посты Untra.dev для /day (баланс рубрик) ---
// Пишутся и при публикации через бота (✅), и при ручном посте в канал
// (апдейт channel_post). Храним только начало текста — модели хватает,
// чтобы понять рубрику.
const RECENT_POSTS_LIMIT = 10;

export function addRecentPost(text) {
  state.recentPosts = state.recentPosts || [];
  state.recentPosts.push({ text: text.slice(0, 400), ts: Date.now() });
  state.recentPosts = state.recentPosts.slice(-RECENT_POSTS_LIMIT);
  saveState(state);
}

export function getRecentPosts() {
  return state.recentPosts || [];
}

// --- Образцы стиля: то, что Азизхон пишет САМ в бизнес-чатах ---
// Одобренные черновики и автоответы сюда не попадают — иначе бот начнёт
// копировать собственный стиль.
const STYLE_SAMPLES_LIMIT = 40;

export function addStyleSample(text) {
  const clean = text.trim();
  if (!clean || clean.length > 400 || clean.startsWith("/")) return;
  state.styleSamples = state.styleSamples || [];
  state.styleSamples.push(clean);
  state.styleSamples = state.styleSamples.slice(-STYLE_SAMPLES_LIMIT);
  saveState(state);
}

export function getStyleSamples(limit = 25) {
  return (state.styleSamples || []).slice(-limit);
}

// --- Кто в чате и что это за чат ---
// title — имя/@username для карточек; kind — "work" | "personal" по последней
// оценке модели. Автоответ разрешён только в "work".
export function setChatMeta(chatId, meta) {
  if (!state.chats[chatId]) state.chats[chatId] = { history: [] };
  Object.assign(state.chats[chatId], meta);
  saveState(state);
}

export function getChatMeta(chatId) {
  const chat = state.chats[chatId] || {};
  return { title: chat.title || "", kind: chat.kind || "unknown" };
}

// --- Сессии Claude (claude --resume): память Рафаэля и /day как в обычном чате ---
export function getSession(key) {
  return state.sessions?.[key] || null;
}

export function setSession(key, sessionId) {
  state.sessions = state.sessions || {};
  state.sessions[key] = sessionId;
  saveState(state);
}

export function clearSession(key) {
  if (state.sessions) delete state.sessions[key];
  saveState(state);
}

// --- Долгая память: факты, которые Мастер попросил запомнить (/remember) ---
export function addMemory(text) {
  state.memory = state.memory || [];
  state.memory.push({ text: text.trim(), ts: Date.now() });
  saveState(state);
  return state.memory.length;
}

export function listMemory() {
  return state.memory || [];
}

export function removeMemory(index) {
  if (!state.memory?.[index]) return false;
  state.memory.splice(index, 1);
  saveState(state);
  return true;
}

// --- Импорт истории из экспорта Telegram Desktop ---
// Старые сообщения из экспорта + то, что бот уже видел; без дублей, по времени.
export function importChatHistory(chatId, { title, messages }) {
  if (!state.chats[chatId]) state.chats[chatId] = { history: [] };
  const chat = state.chats[chatId];
  const seen = new Set(chat.history.map((m) => `${m.ts}|${m.text}`));
  const merged = [...chat.history];
  for (const m of messages) {
    const key = `${m.ts}|${m.text}`;
    if (!seen.has(key)) {
      merged.push(m);
      seen.add(key);
    }
  }
  merged.sort((a, b) => a.ts - b.ts);
  chat.history = merged.slice(-config.chatStoreLimit);
  if (title && !chat.title) chat.title = title;
  const own = chat.history.filter((m) => m.role === "azizhon");
  if (own.length) {
    chat.azizhonEverReplied = true;
    chat.lastAzizhonTs = Math.max(chat.lastAzizhonTs || 0, ...own.map((m) => m.ts));
  }
  saveState(state);
  return chat.history.length;
}

// Поиск клиентского чата по id, @username или части имени — для Рафаэля.
export function findChats(query) {
  const q = String(query).trim().replace(/^#/, "").toLowerCase();
  const entries = Object.entries(state.chats || {}).filter(([key]) => !key.includes(":"));
  const exact = entries.filter(([key]) => key === q);
  if (exact.length) return exact.map(([key]) => key);
  return entries.filter(([, data]) => (data.title || "").toLowerCase().includes(q)).map(([key]) => key);
}
