import { readSystemFile } from "./untra/store.js";
// Планировщик: напоминает про посты и комментарии на всех площадках по
// расписанию из стратегий (время Ташкента, вне школы и курсов), готовит
// адаптации постов для Contra/LinkedIn, утренняя сводка и недельный отчёт (Пн).
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
import { pickCalm } from "./calm.js";

// Память Мастера — через провайдера (team.js импортирует planner.js).
let memoryProvider = () => "";
export function setPlannerMemoryProvider(fn) {
  memoryProvider = fn;
}
function getMemoryForAgents() {
  try {
    return memoryProvider() || "";
  } catch {
    return "";
  }
}

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
  // Антивыгорание: Вс — ничего; Сб — без работы; работа не позже 21:00.
  // hidden — не показывать в утренней сводке; window — сколько минут задача ещё может сработать.
  { key: "brief", label: "Утренняя сводка", days: [1, 2, 3, 4, 5], time: "11:00", platform: null },
  { key: "tg_post", label: "Пост в Untra.dev", days: [2, 4], time: "13:00", platform: "telegram" },
  { key: "contra_post", label: "Пост на Contra", days: [2, 4], time: "13:05", platform: "contra" },
  // reddit выключен: по стратегии 10.2026 только LinkedIn и Contra.
  { key: "linkedin_post", label: "Пост в LinkedIn", days: [5], time: "13:00", platform: "linkedin", evenWeeks: true },
  { key: "linkedin_comments", label: "Комментарии в LinkedIn", days: [3], time: "13:30", platform: "linkedin" },
  { key: "contra_comments", label: "Комментарии на Contra (3 шт.)", days: [1, 2, 3, 4, 5], time: "11:30", platform: "contra" },
  { key: "contra_foryou_1", label: "Contra: For you", days: [1, 2, 3, 4, 5], time: "08:05", platform: "contra", hidden: true, window: 30 },
  { key: "contra_foryou_2", label: "Contra: For you", days: [1, 2, 3, 4, 5], time: "11:00", platform: "contra", hidden: true, window: 30 },
  { key: "contra_foryou_3", label: "Contra: For you", days: [1, 2, 3, 4, 5], time: "14:00", platform: "contra", hidden: true, window: 30 },
  { key: "contra_foryou_4", label: "Contra: For you", days: [2, 4], time: "18:00", platform: "contra", hidden: true, window: 30 },
  { key: "contra_foryou_5", label: "Contra: For you", days: [1, 2, 3, 4, 5], time: "20:40", platform: "contra", hidden: true, window: 15 },
  { key: "discovery_report", label: "Отчёт по каналам для комментариев", days: [1], time: "12:00", platform: null },
  { key: "weekly", label: "Недельный отчёт", days: [1], time: "11:05", platform: null },
  { key: "evening_plan", label: "План на завтра", days: [1, 2, 3, 4], time: "20:45", platform: null, window: 15 },
  { key: "school_rem", label: "Школа", days: [1, 2, 3, 4, 5], time: "08:15", platform: null, hidden: true, window: 15 },
  { key: "physics_rem", label: "Физика", days: [1, 3, 5], time: "14:15", platform: null, hidden: true, window: 15 },
  { key: "math_rem", label: "Математика", days: [1, 3, 5], time: "16:00", platform: null, hidden: true, window: 20 },
  { key: "english_rem", label: "Английский", days: [2, 4, 6], time: "15:15", platform: null, hidden: true, window: 15 },
  { key: "calm_1", label: "Спокойное сообщение", days: [0, 1, 2, 3, 4, 5, 6], time: "12:30", platform: null, hidden: true, window: 60 },
  { key: "calm_2", label: "Спокойное сообщение", days: [0, 1, 2, 3, 4, 5, 6], time: "19:30", platform: null, hidden: true, window: 60 },
];
const WINDOW_MIN = 180;
// Тихие часы: после 23:30 и до 08:00 бот ничего не напоминает (стратегия Contra 07.10).
export function isQuietTime(now = tashkentNow()) {
  const m = toMin(now.time);
  return m >= toMin("23:30") || m < toMin("08:00");
}

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
  return diff >= 0 && diff <= (task.window ?? WINDOW_MIN);
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
    system: `Ты адаптируешь посты Азиза (frontend-разработчик, бренд Untra.dev) под другие площадки. Ничего не выдумывай сверх исходного поста.\n\n${rules}\n\n${getMemoryForAgents()}`,
    prompt: `Исходный пост из Telegram-канала:\n<<<\n${p.text}\n>>>\nВерни только готовый текст.`,
    timeoutMs: 120_000,
  });
  const text = String(raw || "").trim();
  return !text || /^SKIP\b/i.test(text) ? null : text;
}

// Форматы постов Contra (playbooks/contra.md, утверждено 07.10). Ротация — не повторять подряд.
export const CONTRA_POST_FORMATS = [
  { key: "figma_to_code", name: "Из Figma в код", hint: "взять красивый концепт дизайнера с Contra (с отметкой автора), сверстать кусок с анимацией, показать видео 10–30 с" },
  { key: "hardest_part", name: "Самым сложным было не…, а…", hint: "реальная трудность из работы (баг, анимация, скорость, админка) + до/после" },
  { key: "poll", name: "Опрос: 2 варианта UI", hint: "два варианта одного экрана, вопрос «какой бы выбрали и почему?»" },
  { key: "list", name: "Список из опыта", hint: "3–5 коротких пунктов: что проверяю перед сдачей сайта / ошибки в админках / что ускоряет Next.js-сайт" },
];

export function nextContraFormat(lastKey) {
  const i = CONTRA_POST_FORMATS.findIndex((f) => f.key === lastKey);
  return CONTRA_POST_FORMATS[(i + 1) % CONTRA_POST_FORMATS.length];
}

async function contraPost() {
  const fmt = nextContraFormat(getAgentValue("contraLastFormat", null));
  setAgentValue("contraLastFormat", fmt.key);
  const recent = latestPost();
  let idea = "";
  try {
    idea = String(
      (await runOneShot({
        role: "writer",
        system: `Ты помогаешь Азизу (full-stack разработчик, Next.js/React/TS/Node/PostgreSQL, бренд Untra.dev) с постами на Contra. Ничего не выдумывай: опыт, проекты и цифры — только из стратегии и памяти ниже. Нет подходящего факта — предложи, что снять/сделать, а не придумывай результат.\n\n${readStrategy("contra")}\n\n${getMemoryForAgents()}`,
        prompt: `Формат сегодня: «${fmt.name}» — ${fmt.hint}.${recent ? `\nПоследний пост канала (можно использовать как материал):\n<<<\n${recent.text.slice(0, 1500)}\n>>>` : ""}\nДай по-русски, коротко, строго так:\nТема: (одна строка)\nКрючок (англ., первая строка поста): ...\nЧто снять/приложить: ...\nЧерновик (англ., 3–6 коротких строк, без длинных тире, без ИИ-слов): ...\nВопрос в конце (англ.): ...\nТеги: 3–4`,
        timeoutMs: 120_000,
      })) || ""
    ).trim();
  } catch (err) {
    console.warn("[planner] Идея поста Contra не сгенерировалась:", err.message);
  }
  const body = idea
    ? `🟣 Сегодня пост на Contra. Формат: ${fmt.name}.\n\n${idea}\n\nПубликуем только после твоего «ок». Через 45 мин после публикации напомню ответить на комменты — нажми ✅, когда выложишь.`
    : `🟣 Сегодня пост на Contra. Формат: ${fmt.name} — ${fmt.hint}.\nФормула: крючок → 3–6 строк → видео/скрины → вопрос в конце. Напиши Джарвису «пост на контру», соберём вместе.`;
  await sendMessageWithButtons(config.ownerTelegramId, body, planButtons("contra_post"));
}

async function contraPostReplies() {
  await sendMessageWithButtons(
    config.ownerTelegramId,
    "🟣 Пост на Contra вышел ~45 мин назад. Загляни: ответь каждому, кто прокомментировал (лучше вопросом), и поставь лайк. Первый час решает охват.",
    planButtons("contra_post_replies")
  );
}

async function linkedinPost() {
  const text = await adaptPost("linkedin");
  const body = text
    ? `🔵 LinkedIn — пост раз в 2 недели. Вариант из последнего поста канала:\n\n${text}\n\nПроверка: не стыдно ли, если прочитает бывший тимлид?`
    : "🔵 LinkedIn — день поста раз в 2 недели. Последний пост канала для LinkedIn не подходит — можно пропустить, это нормально (лучше ничего, чем кринж).";
  await sendMessageWithButtons(config.ownerTelegramId, body, planButtons("linkedin_post"));
}

// Комментарии Contra (playbooks/contra.md, утверждено 07.10): 3 в день по типам + угол дня.
export const CONTRA_COMMENT_ANGLES = [
  "под концептом дизайнера: как этот hover/анимация поведёт себя на телефоне и как бы ты это сделал",
  "под концептом дизайнера: что в этом макете будет сложнее всего сверстать и почему (адаптив, длинные тексты, пустые состояния)",
  "под свежим постом про Frontend/Next.js: реальный нюанс из Noor или Telegram Store + вопрос автору",
  "под постом фаундера/агентства о запуске: вопрос про то, кто будет редактировать контент и как",
  "под постом про дашборды/админки: деталь из Noor (роли, фильтры, real-time) + вопрос",
  "ответь тем, кто ответил тебе вчера — живой диалог заметнее всего, при диалоге подпишись",
];

async function contraComments() {
  const angle = CONTRA_COMMENT_ANGLES[new Date().getDate() % CONTRA_COMMENT_ANGLES.length];
  await sendMessageWithButtons(
    config.ownerTelegramId,
    [
      "🟣 Contra: 3 комментария сегодня (~10 мин).",
      "• 2 — под концептами дизайнеров (сайты/приложения): одна техническая мысль о реализации.",
      "• 1 — под свежим постом Frontend/UI (первые 1–2 часа) или постом фаундера/агентства.",
      `Угол дня: ${angle}.`,
      "Правила: 1–3 предложения, без «great work», без ссылок; вопрос в конце, чтобы автор ответил. Нечего добавить — пропусти пост.",
    ].join("\n"),
    planButtons("contra_comments")
  );
}

async function contraForYou() {
  await sendMessage(config.ownerTelegramId, "Contra: загляни в «For you» — новые заказы (2–3 минуты, откликнуться только на подходящие).");
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
  const today = TASKS.filter((t) => !t.hidden && !["brief", "weekly", "discovery_report", "evening_plan"].includes(t.key) && taskDueToday(t, now));
  const lines = [`☀️ План на сегодня (${now.date})`];
  if (today.length) for (const t of today) lines.push(`• ${t.time} — ${t.label}`);
  else lines.push("• по площадкам сегодня ничего обязательного");
  const drafts = pendingCommentDrafts();
  lines.push("", `💬 Комментарии в Telegram: ${commentsActive() ? `ждут решения ${drafts}, отправлено сегодня ${getDailyCount("commentsSent")}` : isMtprotoReady() ? "агент выключен (/comments on)" : "MTProto не подключён"}`);
  const tasks = listOpenTasks();
  if (tasks.length) lines.push(`📝 Открытых задач: ${tasks.length} (/todo)`);
  try {
    const nowMd = readSystemFile("state/NOW.md");
    const m = nowMd.match(/## План на[^\n]*\n([\s\S]*?)(?=\n## |$)/);
    if (m) lines.push("", "📋 План из NOW.md:", m[1].trim().split("\n").slice(0, 15).join("\n"));
  } catch {}
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
    if (k === "brief" || k === "weekly" || k === "evening_plan") continue;
    lines.push(`• ${label[k] || k}: сделано ${v.done}${v.skip ? `, пропущено ${v.skip}` : ""}`);
  }
  lines.push("", "Contra (посмотри и скажи Джарвису): score, подписчики, просмотры постов, ответы на комменты, отклики/ответы. Какой пост сработал лучше всего?");
  lines.push("Цифры заявок, созвонов и оплат — из CRM.");
  return lines.join("\n");
}

let eveningPlanRunner = null;
export function setEveningPlanRunner(fn) {
  eveningPlanRunner = fn;
}

const RUNNERS = {
  evening_plan: () => eveningPlanRunner?.(),
  brief: () => sendMessage(config.ownerTelegramId, morningBriefText()),
  tg_post: tgPostReminder,
  contra_post: contraPost,
  contra_comments: contraComments,
  contra_post_replies: contraPostReplies,
  linkedin_post: linkedinPost,
  linkedin_comments: linkedinComments,
  reddit: redditTask,
  showoff: showoffReminder,
  discovery_report: async () => {
    const t = discoveryReportText();
    if (t) await sendMessage(config.ownerTelegramId, t);
  },
  contra_foryou_1: contraForYou,
  contra_foryou_2: contraForYou,
  contra_foryou_3: contraForYou,
  contra_foryou_4: contraForYou,
  contra_foryou_5: contraForYou,
  school_rem: () => sendMessage(config.ownerTelegramId, "🏫 Через 15 минут школа. Время собираться."),
  physics_rem: () => sendMessage(config.ownerTelegramId, "⚛️ Через 15 минут физика. Удачи на занятии!"),
  math_rem: () => sendMessage(config.ownerTelegramId, "📐 Пора выходить на математику, дорога займёт около часа."),
  english_rem: () => sendMessage(config.ownerTelegramId, "🇬🇧 Через 15 минут английский. Удачи на занятии!"),
  calm_1: () => sendMessage(config.ownerTelegramId, pickCalm()),
  calm_2: () => sendMessage(config.ownerTelegramId, pickCalm()),
  weekly: () => sendMessage(config.ownerTelegramId, weeklyReportText()),
};

let running = false;

// Вызывается из основного цикла (часто). Работа с моделью идёт в фоне.
export function plannerTick() {
  if (!config.plannerEnabled || running) return;
  const now = tashkentNow();
  if (isQuietTime(now)) return;
  const fired = getAgentValue("plannerFired", {});
  const due = TASKS.filter((t) => shouldFire(t, now, fired));
  // Отложенные «⏰ Позже».
  // Отложенные рабочие напоминания не показываем в воскресенье и после 21:00.
  const workQuiet = now.dow === 0 || toMin(now.time) >= toMin("21:00");
  const snoozes = workQuiet ? [] : getAgentValue("plannerSnoozes", []).filter((s) => s.at <= Date.now());
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
    if (key === "contra_post") updateAgentValue("plannerSnoozes", [], (list) => list.push({ key: "contra_post_replies", at: Date.now() + 45 * 60_000 }));
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
