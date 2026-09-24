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
  const trimmed = state.chats[chatId].history.slice(-config.historyLimit);
  state.chats[chatId].history = trimmed;
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
export function isContentModeActive(chatId) {
  return Boolean(state.contentMode?.[chatId]);
}

export function setContentMode(chatId, active) {
  state.contentMode = state.contentMode || {};
  state.contentMode[chatId] = active;
  saveState(state);
}

// Сводка по всем клиентским чатам для /chats — без секретарской переписки.
export function listChatSummaries() {
  return Object.entries(state.chats || {})
    .filter(([key]) => !key.startsWith("secretary:"))
    .map(([chatId, data]) => {
      const history = data.history || [];
      const last = history[history.length - 1];
      return {
        chatId,
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

export function hasAzizhonEverReplied(chatId) {
  return Boolean(state.chats[chatId]?.azizhonEverReplied);
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
