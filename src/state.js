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
