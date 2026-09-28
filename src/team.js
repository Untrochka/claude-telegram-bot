// Рафаэль и бот — одна команда. Здесь:
// - botStateText(): короткая сводка состояния бота для системного промпта Рафаэля
//   (что включено, модели, лимиты, план на сегодня, задачи, черновики);
// - eventsText(): журнал — команды Мастера и всё, что бот присылал сам;
// - localRoute(): простые фразы выполняются без Claude (экономия лимитов),
//   всё остальное идёт Рафаэлю.
import { config } from "./config.js";
import {
  getBotNotes,
  addBotNote,
  listOpenTasks,
  getTodayAutoSendCount,
  getAutoSendToggle,
  isContentModeActive,
  getAgentValue,
  getDailyCount,
  listRecentDrafts,
  listMemory,
} from "./state.js";
import { ROLES, getModel } from "./models.js";
import { getWatch, commentsActive, getCommentHistory } from "./comments.js";
import { isMtprotoReady } from "./mtproto.js";
import { TASKS, taskDueToday, tashkentNow } from "./planner.js";

export function logEvent(text) {
  addBotNote(text);
}

function fmt(ts) {
  return new Date(ts).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" });
}

export function eventsText(limit = 8) {
  const notes = getBotNotes().slice(-limit);
  if (!notes.length) return "(пока пусто)";
  return notes.map((n) => `[${fmt(n.ts)}] ${n.text.replace(/\s+/g, " ").slice(0, 260)}`).join("\n");
}

export function botStateText(ownerChatId) {
  const autoOverride = getAutoSendToggle();
  const autoOn = autoOverride === undefined || autoOverride === null ? config.autoSendEnabled : autoOverride;
  const models = Object.keys(ROLES).map((r) => `${r}=${getModel(r)}`).join(", ");
  const watch = Object.entries(getWatch());
  const now = tashkentNow();
  const today = TASKS.filter((t) => !["brief", "weekly", "discovery_report"].includes(t.key) && taskDueToday(t, now));
  const todayStart = new Date(`${now.date}T00:00:00+05:00`).getTime();
  const doneToday = new Set(getAgentValue("planLog", []).filter((e) => e.ts >= todayStart && e.status === "done").map((e) => e.key));
  const plan = today.length ? today.map((t) => `${t.time} ${t.label}${doneToday.has(t.key) ? " ✅" : ""}`).join("; ") : "обязательного нет";
  const tasks = listOpenTasks();
  const drafts = listRecentDrafts(20);
  const byKind = drafts.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
  const kindLabel = { business: "клиентам", channel_post: "постов", comment: "комментариев", reddit: "Reddit" };
  return [
    `Время: ${now.date} ${now.time} (Ташкент).`,
    `Режим: ${config.dryRun ? "DRY_RUN (ничего не отправляется)" : "боевой"}. MTProto: ${isMtprotoReady() ? "подключён" : "не подключён"}. /day: ${ownerChatId && isContentModeActive(ownerChatId) ? "идёт" : "не идёт"}.`,
    `Автоответы клиентам: ${autoOn ? "вкл" : "выкл"}, сегодня отправлено ${getTodayAutoSendCount()}.`,
    `Модели: ${models}.`,
    `Агент комментариев: ${commentsActive() ? "работает" : "выключен"}; каналов ${watch.length}/${config.watchMax}${watch.length ? ` (${watch.map(([u]) => `@${u}`).join(", ")})` : ""}; сегодня черновиков ${getDailyCount("commentDrafts")}/${config.commentDraftsPerDay}, отправлено ${getDailyCount("commentsSent")}/${config.maxCommentsPerDay}.`,
    `План на сегодня: ${plan}.`,
    `Черновики ждут решения: ${drafts.length ? Object.entries(byKind).map(([k, n]) => `${kindLabel[k] || k} ${n}`).join(", ") : "нет"}.`,
    `Открытые задачи (${tasks.length}): ${tasks.slice(0, 5).map((t) => `#${t.id} ${t.text.slice(0, 60)}`).join("; ") || "нет"}.`,
    `Фактов в памяти: ${listMemory().length}.`,
  ].join("\n");
}

// --- Простые фразы без Claude ---
// Только очень уверенные совпадения; всё сомнительное — Рафаэлю.
// -> { action, arg } | null
export function localRoute(text) {
  const t = text.trim();
  if (t.length > 120 || t.includes("\n")) return null;
  const low = t.toLowerCase();

  if (/^(план( на сегодня)?|что (у меня )?(сегодня|по плану)|что сегодня делать)\??!?$/i.test(low)) return { action: "plan", arg: "" };
  if (/^(мои )?задачи\??$|^(что|какие) (у меня )?задачи\??$/i.test(low)) return { action: "todo_list", arg: "" };

  const remember = t.match(/^запомни[,:]?\s+(.{3,})$/i);
  if (remember) return { action: "remember", arg: remember[1].trim() };

  const remind = t.match(/^напомни( мне)?\s+через\s+(\d+)\s*(мин|минут[уы]?|м|час|часа|часов|ч|день|дня|дней|д)\s+(.{2,})$/i);
  if (remind) {
    const n = remind[2];
    const u = remind[3].toLowerCase();
    const unit = u.startsWith("м") ? "m" : u.startsWith("ч") ? "h" : "d";
    return { action: "remind", arg: `${n}${unit} ${remind[4].replace(/^(что|о том что|про)\s+/i, "").trim()}` };
  }

  // \b в JS не работает с кириллицей — границы слов через пробелы.
  if (/^(найди|поищи|ищи|добавь|подбери)(\s.{0,25})?\s?канал/i.test(low) && !/(^|\s)(как|почему|зачем)(\s|$)/.test(low)) return { action: "watch_find", arg: "" };
  if (/^(проверь|чекни|посмотри)(\s.{0,20})?\s?(канал|пост|коммент)/i.test(low)) return { action: "comments_check", arg: "" };
  if (/^(найди|покажи|дай)(\s.{0,20})?\s?(reddit|реддит)/i.test(low)) return { action: "reddit", arg: "" };
  return null;
}

export const LOCAL_ACK = {
  plan: null,
  todo_list: null,
  remember: null,
  remind: null,
  watch_find: null,
  comments_check: null,
  reddit: null,
};

// Память Мастера (/remember) для других частей бота — с предупреждением,
// что это приватные заметки и в публичные тексты они не попадают.
export function memoryForAgents() {
  const facts = listMemory();
  if (!facts.length) return "";
  return `Заметки Мастера (/remember) — только для понимания контекста. В публичные тексты (комментарии, посты) имена клиентов, цены, личные детали из них НЕ вставлять:\n${facts
    .slice(-20)
    .map((f) => `- ${f.text}`)
    .join("\n")}`;
}

// Последние комментарии (черновики и отправленные) с постом — для Рафаэля.
export function commentsContextText(limit = 5) {
  const list = getCommentHistory().slice(-limit);
  if (!list.length) return "Комментариев пока не было.";
  return list
    .map((c) => {
      const post = (c.postText || "").replace(/\s+/g, " ").slice(0, 450);
      return `#${c.id} @${c.username} — ${c.status}${c.link ? ` (${c.link})` : ""}\n  Пост: ${post}\n  Комментарий: ${(c.text || "").replace(/\s+/g, " ")}`;
    })
    .join("\n");
}

// Найти комментарий по тексту сообщения, на которое Мастер ответил или которое переслал.
export function findCommentByText(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ");
  return (
    getCommentHistory()
      .slice()
      .reverse()
      .find((c) => (c.link && t.includes(c.link)) || (c.username && c.postId && t.includes(`t.me/${c.username}/${c.postId}`)) || (c.text && t.includes(c.text.replace(/\s+/g, " ").slice(0, 60)))) || null
  );
}
