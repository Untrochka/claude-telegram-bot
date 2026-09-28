// Планировщик: напоминает про посты и комментарии на всех площадках по
// расписанию из стратегий (время Ташкента, вне школы и курсов), готовит
// адаптации постов для Contra/LinkedIn, утренняя сводка и воскресный отчёт.
// Всё только владельцу. Кнопки: ✅ Сделал / ⏰ Позже (+2 ч) / 🙅 Пропускаю.
import { config } from "./config.js";
import { runOneShot } from "./claudeClient.js";
import { readStrategy } from "./strategies.js";
import {
  getAgentValue,
  setAgentValue,
  updateAgentValue,
  getRecentPosts,
  listOpenTasks,
  getDailyCount,
} from "./state.js";
import { sendMessage, sendMessageWithButtons, editMessageText } from "./telegram.js";
import { pendingCommentDrafts, discoveryReportText, commentsActive } from "./comments.js";
import { runRedditDigest } from "./reddit.js";
import { isMtprotoReady } from "./mtproto.js";

// --- Время Ташкента ---
export function tashkentNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, dow, time: `${hh}:${parts.minute}`, day: Number(parts.day) };
}

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// days: 0=Вс … 6=Сб. window — сколько минут после времени задача ещё может
// сработать (если бот был выключен). platform — для отчёта.
export const TASKS = [
  { key: "brief", label: "Утренняя сводка", days: [0, 1, 2, 3, 4, 5, 6], time: "11:00", platform: null },
  { key: "tg_post", label: "Пост в Untra.dev", days: [2, 4, 6], time: "13:00", platform: "telegram" },
  { key: "contra_post", label: "Пост на Contra", days: [2, 4, 6], time: "13:05", platform: "contra" },
  { key: "reddit", label: "Reddit: ответы на вопросы", days: [2, 4, 6], time: "18:00", platform: "reddit" },
  { key: "showoff", label: "Reddit Showoff Saturday", days: [6], time: "12:00", platform: "reddit", firstWeekOfMonth: true },
  { key: "linkedin_post", label: "Пост в LinkedIn", days: [5], time: "13:00", platform: "linkedin", evenWeeks: true },
  { key: "linkedin_comments", label: "Комментарии в LinkedIn", days: [3], time: "21:35", platform: "linkedin" },
  { key: "contra_comments", label: "Комментарии на Contra", days: [0, 1, 2, 3, 4, 5, 6], time: "21:30", platform: "contra" },
  { key: "discovery_report", label: "Отчёт по каналам для комментариев", days: [1], time: "12:00", platform: null },
  { key: "weekly", label: "Воскресный отчёт", days: [0], time: "20:00", platform: null },
];
const WINDOW_MIN = 180;

export function taskDueToday(task, now = tashkentNow(), date = new Date()) {
  if (!task.days.includes(now.dow)) return false;
  if (task.evenWeeks && isoWeek(date) % 2 !== 0) return false;
  if (task.firstWeekOfMonth && now.day > 7) return false;
  return true;
}

export function shouldFire(task, now, firedMap, date = new Date()) {
  if (!taskDueToday(task, now, date)) return false;
  if (firedMap[`${task.key}:${now.date}`]) return false;
  const diff = toMin(now.time) - toMin(task.time);
  return diff >= 0 && diff <= WINDOW_MIN;
}

function markFired(key, date) {
  updateAgentValue("plannerFired", {}, (f) => {
    f[`${key}:${date}`] = Date.now();
    // чистим старьё
    const keys = Object.keys(f);
    if (keys.length > 200) keys.sort((a, b) => f[a] - f[b]).slice(0, keys.length - 200).forEach((k) => delete f[k]);
  });
}

function logPlan(key, status) {
  updateAgentValue("planLog", [], (log) => {
    log.push({ key, status, ts: Date.now() });
    if (log.length > 500) log.splice(0, log.length - 500);
  });
}

function planButtons(key, extraRow = null) {
  const rows = [];
  if (extraRow) rows.push(extraRow);
  rows.push([
    { text: "✅ Сделал", callback_data: `p:d:${key}` },
    { text: "⏰ Позже", callback_data: `p:l:${key}` },
    { text: "🙅 Пропускаю", callback_data: `p:s:${key}` },
  ]);
  return rows;
}

function postedToday() {
  const today = tashkentNow().date;
  return getRecentPosts().some((p) => tashkentNow(new Date(p.ts)).date === today);
}

function latestPost(maxAgeDays = 7) {
  const posts = getRecentPosts();
  const p = posts[posts.length - 1];
  if (!p || Date.now() - p.ts > maxAgeDays * 86_400_000) return null;
  return p;
}

// --- Задачи ---
async function tgPostReminder() {
  if (postedToday()) {
    logPlan("tg_post", "done");
    return;
  }
  await sendMessageWithButtons(
    config.ownerTelegramId,
    "📣 Сегодня день поста в Untra.dev.\nЕсть материал (запись экрана, скрин, что-то интересное за 1–2 дня)? Если нет — давай разберём день, я найду историю.",
    planButtons("tg_post", [{ text: "🗓 Начать /day", callback_data: "p:day:tg_post" }])
  );
}

async function adaptPost(platform) {
  const p = latestPost();
  if (!p) return null;
  const rules =
    platform === "contra"
      ? `Сделай пост для Contra на английском по стратегии ниже: 2–3 простых живых предложения, без "I'm excited", без длинных тире, можно с маленькой буквы. В конце — строка "Tags: ..." (2–4 тега) и строка "Media: ..." (что приложить из поста канала).\n\n${readStrategy("contra")}`
      : `Сделай пост для LinkedIn на английском по стратегии ниже (формат A или B, 2–4 предложения фактов, ноль кринжа, без длинных тире «—» и без эмодзи). Если исходный пост про жизнь/клиентов/учёбу и для LinkedIn не подходит — ответь одним словом SKIP.\n\n${readStrategy("linkedin")}`;
  const raw = await runOneShot({
    role: "writer",
    system: `Ты адаптируешь посты Азиза (frontend-разработчик, бренд Untra.dev) под другие площадки. Ничего не выдумывай сверх исходного поста.\n\n${rules}`,
    prompt: `Исходный пост из Telegram-канала:\n<<<\n${p.text}\n>>>\nВерни только готовый текст.`,
    timeoutMs: 120_000,
  });
  const text = String(raw || "").trim();
  return !text || /^SKIP\b/i.test(text) ? null : text;
}

async function contraPost() {
  const text = await adaptPost("contra");
  if (!text) {
    await sendMessageWithButtons(
      config.ownerTelegramId,
      "🟣 Сегодня пост на Contra. Свежего поста в канале за неделю нет — сначала пост в Untra.dev (/day), потом я сделаю английскую версию.",
      planButtons("contra_post")
    );
    return;
  }
  await sendMessageWithButtons(config.ownerTelegramId, `🟣 Пост для Contra (из последнего поста канала):\n\n${text}\n\nВыложи на contra.com → Create → Post.`, planButtons("contra_post"));
}

async function linkedinPost() {
  const text = await adaptPost("linkedin");
  const body = text
    ? `🔵 LinkedIn — пост раз в 2 недели. Вариант из последнего поста канала:\n\n${text}\n\nПроверка: не стыдно ли, если прочитает бывший тимлид?`
    : "🔵 LinkedIn — день поста раз в 2 недели. Последний пост канала для LinkedIn не подходит — можно пропустить, это нормально (лучше ничего, чем кринж).";
  await sendMessageWithButtons(config.ownerTelegramId, body, planButtons("linkedin_post"));
}

const CONTRA_TIPS = [
  "ищи посты основателей про запуск продукта — спроси по делу или добавь нюанс из опыта",
  "загляни в посты сильных дизайнеров: комментарий про то, как такой интерфейс ведёт себя в коде, заходит лучше «nice work»",
  "посты про e-commerce и дашборды — твоя тема: одна реальная деталь из Noor или BUCHET.UZ",
  "посты про Telegram и Mini Apps — там почти никто не комментирует со знанием дела",
  "отвечай тем, кто ответил тебе вчера — диалог в комментариях заметнее всего",
];

async function contraComments() {
  const tip = CONTRA_TIPS[new Date().getDate() % CONTRA_TIPS.length];
  await sendMessageWithButtons(
    config.ownerTelegramId,
    `🟣 Contra: 3–5 комментариев сегодня (10 минут).\nСовет дня: ${tip}.\nФормула: опыт / нюанс / вопрос по делу, 1–3 предложения, без «great post».`,
    planButtons("contra_comments")
  );
}

async function linkedinComments() {
  await sendMessageWithButtons(
    config.ownerTelegramId,
    "🔵 LinkedIn: 3–5 комментариев на неделе (10 минут).\nПод постами бывших коллег (Noor, BUCHET.UZ), местных разработчиков и CTO, основателей. 1–3 предложения: опыт или вопрос по делу.\n+ одно личное сообщение бывшему коллеге: «я на фрилансе, если кому-то нужен разработчик — вспомни обо мне».",
    planButtons("linkedin_comments")
  );
}

async function redditTask() {
  const n = await runRedditDigest({ maxDrafts: 3 });
  if (!n) {
    await sendMessageWithButtons(
      config.ownerTelegramId,
      "🟠 Reddit: подходящих свежих вопросов не нашёл. Если есть 10 минут — загляни в r/nextjs или r/reactjs (New) и ответь на 1–2 вопроса.",
      planButtons("reddit")
    );
  }
}

async function showoffReminder() {
  await sendMessageWithButtons(
    config.ownerTelegramId,
    "🟠 Первая суббота месяца — Showoff Saturday в r/webdev. Можно выложить демо (бот записи или каталог): заголовок что это + 3–5 предложений + видео/GIF, ссылка на демо в первом комментарии.",
    planButtons("showoff")
  );
}

export function morningBriefText() {
  const now = tashkentNow();
  const today = TASKS.filter((t) => t.key !== "brief" && t.key !== "weekly" && t.key !== "discovery_report" && taskDueToday(t, now));
  const lines = [`☀️ План на сегодня (${now.date})`];
  if (today.length) for (const t of today) lines.push(`• ${t.time} — ${t.label}`);
  else lines.push("• по площадкам сегодня ничего обязательного");
  const drafts = pendingCommentDrafts();
  lines.push("", `💬 Комментарии в Telegram: ${commentsActive() ? `ждут решения ${drafts}, отправлено сегодня ${getDailyCount("commentsSent")}` : isMtprotoReady() ? "агент выключен (/comments on)" : "MTProto не подключён"}`);
  const tasks = listOpenTasks();
  if (tasks.length) lines.push(`📝 Открытых задач: ${tasks.length} (/todo)`);
  if (now.dow === 6) lines.push("🎬 Сегодня контент-сессия: собери записи экрана за неделю → 3 поста + Reels.");
  return lines.join("\n");
}

function weeklyReportText() {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const log = getAgentValue("planLog", []).filter((e) => e.ts > weekAgo);
  const byKey = {};
  for (const e of log) {
    byKey[e.key] = byKey[e.key] || { done: 0, skip: 0 };
    if (e.status === "done") byKey[e.key].done += 1;
    if (e.status === "skip") byKey[e.key].skip += 1;
  }
  const comments = getAgentValue("commentsLog", []).filter((e) => e.ts > weekAgo).length;
  const posts = getRecentPosts().filter((p) => p.ts > weekAgo).length;
  const label = Object.fromEntries(TASKS.map((t) => [t.key, t.label]));
  label.reddit_answer = "Ответы на Reddit";
  const lines = ["📊 Неделя:", `• Постов в Untra.dev: ${posts} (цель 3)`, `• Комментариев в Telegram через бота: ${comments}`];
  for (const [k, v] of Object.entries(byKey)) {
    if (k === "brief" || k === "weekly") continue;
    lines.push(`• ${label[k] || k}: сделано ${v.done}${v.skip ? `, пропущено ${v.skip}` : ""}`);
  }
  lines.push("", "Цифры для таблицы в 00_STATUS.md: заявки, созвоны и оплаты из CRM — запиши сам, у бота их нет.");
  return lines.join("\n");
}

const RUNNERS = {
  brief: () => sendMessage(config.ownerTelegramId, morningBriefText()),
  tg_post: tgPostReminder,
  contra_post: contraPost,
  contra_comments: contraComments,
  linkedin_post: linkedinPost,
  linkedin_comments: linkedinComments,
  reddit: redditTask,
  showoff: showoffReminder,
  discovery_report: async () => {
    const t = discoveryReportText();
    if (t) await sendMessage(config.ownerTelegramId, t);
  },
  weekly: () => sendMessage(config.ownerTelegramId, weeklyReportText()),
};

let running = false;

// Вызывается из основного цикла (часто). Работа с моделью идёт в фоне.
export function plannerTick() {
  if (!config.plannerEnabled || running) return;
  const now = tashkentNow();
  const fired = getAgentValue("plannerFired", {});
  const due = TASKS.filter((t) => shouldFire(t, now, fired));
  // Отложенные «⏰ Позже».
  const snoozes = getAgentValue("plannerSnoozes", []).filter((s) => s.at <= Date.now());
  if (!due.length && !snoozes.length) return;

  running = true;
  (async () => {
    for (const t of due) {
      markFired(t.key, now.date);
      try {
        await RUNNERS[t.key]?.();
      } catch (err) {
        console.error(`[planner] Задача ${t.key} упала:`, err.message);
      }
    }
    if (snoozes.length) {
      const cutoff = Date.now();
      updateAgentValue("plannerSnoozes", [], (list) => {
        const keep = list.filter((x) => x.at > cutoff);
        list.length = 0;
        list.push(...keep);
      });
      for (const s of snoozes) {
        try {
          await RUNNERS[s.key]?.();
        } catch (err) {
          console.error(`[planner] Отложенная задача ${s.key} упала:`, err.message);
        }
      }
    }
  })().finally(() => {
    running = false;
  });
}

// Кнопки напоминаний. -> текст для answerCallbackQuery или { startDay: true }.
export async function handlePlanCallback(query, action, key) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const text = query.message.text || "";
  if (action === "day") {
    logPlan(key, "started_day");
    await editMessageText(chatId, messageId, `${text}\n\n🗓 Начали /day.`);
    return { startDay: true };
  }
  if (action === "d") {
    logPlan(key, "done");
    await editMessageText(chatId, messageId, `${text}\n\n✅ Сделано.`);
    return "Красава";
  }
  if (action === "s") {
    logPlan(key, "skip");
    await editMessageText(chatId, messageId, `${text}\n\n🙅 Пропускаю сегодня.`);
    return "Ок, пропускаем";
  }
  if (action === "l") {
    updateAgentValue("plannerSnoozes", [], (list) => list.push({ key, at: Date.now() + 2 * 3_600_000 }));
    logPlan(key, "later");
    await editMessageText(chatId, messageId, `${text}\n\n⏰ Напомню через 2 часа.`);
    return "Напомню через 2 ч";
  }
  return null;
}

export async function runTaskNow(key) {
  await RUNNERS[key]?.();
}
