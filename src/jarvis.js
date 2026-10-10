// Настройки Джарвиса: один файл state/jarvis.json в системе untra (виден через
// MCP-коннектор). Расписание, правила, напоминания, стиль, важные задачи и
// слежение за чатами меняются словами в чате (маркер [[JARVIS_SET: …]]) —
// код править не нужно. Планировщик (planner.js) и наблюдатель (watcher.js)
// читают этот файл; Джарвис видит его сжатый вид в системном промпте.
import fs from "node:fs";
import path from "node:path";
import { readSystemFile, writeSystemFile, SYSTEM_DIR } from "./untra/store.js";

export const JARVIS_FILE = "state/jarvis.json";

// Ключи задач, которые умеет запускать планировщик (RUNNERS в planner.js; тест сверяет).
export const TASK_KEYS = [
  "brief",
  "tg_post",
  "contra_post",
  "contra_post_replies",
  "contra_comments",
  "linkedin_post",
  "linkedin_comments",
  "reddit",
  "showoff",
  "discovery_report",
  "weekly",
  "evening_plan",
  "study_checkin",
];

// Предметы учёбы (study.js) — здесь, чтобы jarvis.js не зависел от study.js.
export const STUDY_SUBJECTS = ["physics", "math", "english", "programming"];
export const WATCH_KINDS = ["general", "study"];

const WD = [1, 2, 3, 4, 5];
const text = (id, label, days, time, msg, extra = {}) => ({ id, label, days, time, work: false, enabled: true, type: "text", text: msg, ...extra });
const task = (id, label, days, time, key, extra = {}) => ({ id, label, days, time, work: true, enabled: true, type: "task", task: key, platform: null, ...extra });
const FORYOU = "Contra: загляни в «For you» — новые заказы (2–3 минуты, откликнуться только на подходящие).";
const forYou = (n, days, time, window) => text(`contra_foryou_${n}`, "Contra: For you", days, time, FORYOU, { work: true, platform: "contra", hidden: true, window });

// Бывший статический TASKS из planner.js — теперь только источник для первого создания файла.
export const DEFAULT_REMINDERS = [
  task("brief", "Утренняя сводка", WD, "11:00", "brief"),
  task("tg_post", "Пост в Untra.dev", [2, 4], "13:00", "tg_post", { platform: "telegram" }),
  task("contra_post", "Пост на Contra", [2, 4], "13:05", "contra_post", { platform: "contra" }),
  task("linkedin_post", "Пост в LinkedIn", [5], "13:00", "linkedin_post", { platform: "linkedin", evenWeeks: true }),
  task("linkedin_comments", "Комментарии в LinkedIn", [3], "13:30", "linkedin_comments", { platform: "linkedin" }),
  task("contra_comments", "Комментарии на Contra (3 шт.)", WD, "11:30", "contra_comments", { platform: "contra" }),
  forYou(1, WD, "08:05", 30),
  forYou(2, WD, "11:00", 30),
  forYou(3, WD, "14:00", 30),
  forYou(4, [2, 4], "18:00", 30),
  forYou(5, WD, "20:40", 15),
  task("discovery_report", "Отчёт по каналам для комментариев", [1], "12:00", "discovery_report"),
  task("weekly", "Недельный отчёт", [1], "11:05", "weekly"),
  task("evening_plan", "План на завтра", [1, 2, 3, 4], "20:45", "evening_plan", { window: 15 }),
  task("study_checkin", "Проверка ДЗ", [1, 2, 3, 4, 5, 6], "20:30", "study_checkin", { work: false, hidden: true, window: 120 }),
  text("school_rem", "Школа", WD, "08:15", "🏫 Через 15 минут школа. Время собираться.", { hidden: true, window: 15 }),
  text("physics_rem", "Физика", [1, 3, 5], "14:15", "⚛️ Через 15 минут физика. Удачи на занятии!", { hidden: true, window: 15 }),
  text("math_rem", "Математика", [1, 3, 5], "16:00", "📐 Пора выходить на математику, дорога займёт около часа.", { hidden: true, window: 20 }),
  text("english_rem", "Английский", [2, 4, 6], "15:15", "🇬🇧 Через 15 минут английский. Удачи на занятии!", { hidden: true, window: 15 }),
  { id: "calm_1", label: "Спокойное сообщение", days: [0, 1, 2, 3, 4, 5, 6], time: "12:30", work: false, enabled: true, type: "calm", hidden: true, window: 60 },
  { id: "calm_2", label: "Спокойное сообщение", days: [0, 1, 2, 3, 4, 5, 6], time: "19:30", work: false, enabled: true, type: "calm", hidden: true, window: 60 },
];

export function defaultJarvis() {
  return {
    version: 1,
    migrated: ["study_checkin"],
    address: "Мастер",
    style: ["коротко и просто"],
    rules: { quietHours: "23:30-08:00", noWorkAfter: "21:00", dayOffWork: [6], dayOffAll: [0] },
    schedule: [
      { id: "school", title: "Школа", days: WD, from: "08:30", to: "10:30" },
      { id: "physics", title: "Физика", days: [1, 3, 5], from: "14:30", to: "15:50" },
      { id: "math", title: "Математика", days: [1, 3, 5], from: "17:00", to: "20:20" },
      { id: "english", title: "Английский", days: [2, 4, 6], from: "15:30", to: "17:00" },
    ],
    reminders: JSON.parse(JSON.stringify(DEFAULT_REMINDERS)),
    tasks: [],
    watch: { intervalMin: 30, from: "08:00", to: "21:00", chats: [], important: ["вопрос ко мне", "деньги и оплата", "встречи и сроки"] },
  };
}

// ---------- проверки ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[a-zA-Z0-9_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const REMINDER_FIELDS = ["id", "label", "days", "time", "work", "enabled", "type", "text", "task", "platform", "hidden", "window", "evenWeeks", "firstWeekOfMonth"];
const LISTS = ["reminders", "schedule", "tasks", "style", "watch.chats"];
const isDays = (v) => Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
const isStr = (v, max = 500) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// Диапазон "HH:MM-HH:MM" (может переходить через полночь). -> true, если time внутри.
export function inRange(range, time) {
  const [a, b] = String(range).split("-");
  const t = toMin(time);
  const from = toMin(a);
  const to = toMin(b);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export const defaultWork = (r) => (typeof r.work === "boolean" ? r.work : r.type === "task");

// Список ошибок для одного напоминания (пустой — всё в порядке).
export function reminderErrors(r) {
  const e = [];
  if (!r || typeof r !== "object") return ["напоминание должно быть объектом"];
  if (!ID_RE.test(String(r.id || ""))) e.push(`id «${r.id}» должен быть из латиницы, цифр и _ (до 40 символов)`);
  if (!isDays(r.days)) e.push(`${r.id}: days — числа 0–6 (0=Вс … 6=Сб), не пусто`);
  if (!TIME_RE.test(String(r.time || ""))) e.push(`${r.id}: time должно быть ЧЧ:ММ`);
  if (!["text", "calm", "task"].includes(r.type)) e.push(`${r.id}: type — text, calm или task`);
  if (r.type === "text" && !isStr(r.text, 1000)) e.push(`${r.id}: для type text нужен text`);
  if (r.type === "task" && !TASK_KEYS.includes(r.task)) e.push(`${r.id}: неизвестный task «${r.task}». Есть: ${TASK_KEYS.join(", ")}`);
  if (r.window !== undefined && !(Number.isInteger(r.window) && r.window >= 1 && r.window <= 720)) e.push(`${r.id}: window — минуты 1–720`);
  for (const f of ["work", "enabled", "hidden", "evenWeeks", "firstWeekOfMonth"]) if (r[f] !== undefined && typeof r[f] !== "boolean") e.push(`${r.id}: ${f} — true/false`);
  return e;
}

// kind: "general" (по умолчанию) | "study"; subject — предмет для чатов учёбы.
function watchChatErrors(c) {
  const e = [];
  if (c.kind !== undefined && !WATCH_KINDS.includes(c.kind)) e.push(`watch.chats ${c.query}: kind — ${WATCH_KINDS.join(" или ")}`);
  if (c.subject !== undefined && !STUDY_SUBJECTS.includes(c.subject)) e.push(`watch.chats ${c.query}: subject — ${STUDY_SUBJECTS.join(", ")}`);
  return e;
}

// Общая проверка всего файла.
export function validateJarvis(j) {
  const e = [];
  if (!j || typeof j !== "object" || Array.isArray(j)) return ["файл должен быть объектом"];
  if (!isStr(j.address, 40)) e.push("address — непустая строка до 40 символов");
  if (!Array.isArray(j.style) || !j.style.every((s) => isStr(s, 300))) e.push("style — список непустых строк");
  const r = j.rules || {};
  if (!RANGE_RE.test(String(r.quietHours || ""))) e.push("rules.quietHours должно быть ЧЧ:ММ-ЧЧ:ММ");
  if (!TIME_RE.test(String(r.noWorkAfter || ""))) e.push("rules.noWorkAfter должно быть ЧЧ:ММ");
  for (const k of ["dayOffWork", "dayOffAll"]) if (!Array.isArray(r[k]) || !r[k].every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) e.push(`rules.${k} — список чисел 0–6`);
  if (!Array.isArray(j.schedule)) e.push("schedule — список");
  else
    for (const s of j.schedule) {
      if (!ID_RE.test(String(s?.id || "")) || !isStr(s.title, 80)) e.push(`schedule: нужны id и title (${s?.id})`);
      else if (!isDays(s.days) || !TIME_RE.test(String(s.from)) || !TIME_RE.test(String(s.to))) e.push(`schedule ${s.id}: days 0–6, from/to ЧЧ:ММ`);
    }
  if (!Array.isArray(j.reminders)) e.push("reminders — список");
  else {
    const seen = new Set();
    for (const rem of j.reminders) {
      e.push(...reminderErrors(rem));
      if (seen.has(rem?.id)) e.push(`id «${rem.id}» повторяется`);
      seen.add(rem?.id);
    }
  }
  if (!Array.isArray(j.tasks)) e.push("tasks — список");
  else
    for (const t of j.tasks) {
      if (!ID_RE.test(String(t?.id || "")) || !isStr(t.text, 500)) e.push(`tasks: нужны id и text (${t?.id})`);
      else if (t.due !== undefined && !DATE_RE.test(String(t.due))) e.push(`tasks ${t.id}: due — ГГГГ-ММ-ДД`);
    }
  const w = j.watch || {};
  if (!(Number.isInteger(w.intervalMin) && w.intervalMin >= 5 && w.intervalMin <= 1440)) e.push("watch.intervalMin — минуты 5–1440");
  if (!TIME_RE.test(String(w.from || "")) || !TIME_RE.test(String(w.to || ""))) e.push("watch.from/to — ЧЧ:ММ");
  if (!Array.isArray(w.chats) || !w.chats.every((c) => isStr(c?.query, 100))) e.push("watch.chats — список {query}");
  else e.push(...w.chats.flatMap(watchChatErrors));
  if (!Array.isArray(w.important) || !w.important.every((s) => isStr(s, 100))) e.push("watch.important — список строк");
  return e;
}

// Недостающие верхние поля добираем из дефолтов (ручная правка файла не ломает бота).
function withDefaults(j) {
  const d = defaultJarvis();
  const out = { ...d, ...j, rules: { ...d.rules, ...(j.rules || {}) }, watch: { ...d.watch, ...(j.watch || {}) } };
  out.version = 1;
  out.migrated = j.migrated; // не из дефолтов: у старого файла флага нет, и миграция должна сработать
  return out;
}

// Разовые миграции старых файлов: добавляем новое напоминание один раз (флаг migrated),
// чтобы удалённое владельцем потом не появлялось снова. -> true, если что-то поменяли.
function migrate(j) {
  j.migrated = Array.isArray(j.migrated) ? j.migrated : [];
  if (j.migrated.includes("study_checkin")) return false;
  j.migrated.push("study_checkin");
  if (!j.reminders.some((r) => r.id === "study_checkin")) j.reminders.push(JSON.parse(JSON.stringify(DEFAULT_REMINDERS.find((r) => r.id === "study_checkin"))));
  return true;
}

export function resetJarvisCache() {
  cache = { obj: null, mtime: 0, checkedAt: 0 };
}

// ---------- чтение / запись ----------
let cache = { obj: null, mtime: 0, checkedAt: 0 };
const CHECK_EVERY_MS = 5_000;

function filePath() {
  return path.join(SYSTEM_DIR, JARVIS_FILE);
}

function remember(obj) {
  let mtime = 0;
  try {
    mtime = fs.statSync(filePath()).mtimeMs;
  } catch {}
  cache = { obj, mtime, checkedAt: Date.now() };
}

export function saveJarvis(obj, who = "jarvis") {
  writeSystemFile(JARVIS_FILE, JSON.stringify(obj, null, 2) + "\n", who);
  remember(obj);
  return obj;
}

export function loadJarvis() {
  const now = Date.now();
  if (cache.obj && now - cache.checkedAt < CHECK_EVERY_MS) return cache.obj;
  try {
    const mtime = fs.statSync(filePath()).mtimeMs;
    if (cache.obj && mtime === cache.mtime) {
      cache.checkedAt = now;
      return cache.obj;
    }
    const parsed = withDefaults(JSON.parse(readSystemFile(JARVIS_FILE)));
    const errors = validateJarvis(parsed);
    if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
    if (migrate(parsed)) {
      try {
        saveJarvis(parsed, "jarvis-migrate");
      } catch (e) {
        console.error("[jarvis] Не смог записать миграцию:", e.message);
        cache = { obj: parsed, mtime, checkedAt: now };
      }
      return parsed;
    }
    cache = { obj: parsed, mtime, checkedAt: now };
    return parsed;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[jarvis] ${JARVIS_FILE} не читается (${err.message}) — пересоздаю по умолчанию, старая версия в history/.`);
    const seed = defaultJarvis();
    try {
      saveJarvis(seed, "jarvis-seed");
    } catch (e) {
      console.error("[jarvis] Не смог записать настройки:", e.message);
      cache = { obj: seed, mtime: 0, checkedAt: now };
    }
    return seed;
  }
}

// ---------- правки ----------
const get = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const keys = p.split(".");
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
};

const SET_PATHS = {
  address: (v) => isStr(v, 40) || "address — непустая строка до 40 символов",
  "rules.quietHours": (v) => RANGE_RE.test(String(v)) || "quietHours должно быть ЧЧ:ММ-ЧЧ:ММ",
  "rules.noWorkAfter": (v) => TIME_RE.test(String(v)) || "noWorkAfter должно быть ЧЧ:ММ",
  "rules.dayOffWork": (v) => (Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) || "dayOffWork — список чисел 0–6 (0=Вс … 6=Сб)",
  "rules.dayOffAll": (v) => (Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) || "dayOffAll — список чисел 0–6 (0=Вс … 6=Сб)",
  "watch.intervalMin": (v) => (Number.isInteger(v) && v >= 5 && v <= 1440) || "intervalMin — целые минуты 5–1440",
  "watch.from": (v) => TIME_RE.test(String(v)) || "watch.from должно быть ЧЧ:ММ",
  "watch.to": (v) => TIME_RE.test(String(v)) || "watch.to должно быть ЧЧ:ММ",
  "watch.important": (v) => (Array.isArray(v) && v.every((s) => isStr(s, 100))) || "watch.important — список строк",
  style: (v) => (Array.isArray(v) && v.every((s) => isStr(s, 300))) || "style — список строк",
};

let idCounter = 0;
function autoId(prefix, list) {
  let id;
  do id = `${prefix}${(Date.now() + idCounter++).toString(36)}`;
  while (list.some((x) => x.id === id));
  return id;
}

const daysText = (d) => (Array.isArray(d) ? d.map((x) => DOW_NAMES[x]).join(",") : "");

function describe(list, v) {
  if (list === "reminders") return `напоминание ${v.id} (${daysText(v.days)} ${v.time}${v.enabled === false ? ", выкл" : ""})`;
  if (list === "schedule") return `расписание «${v.title}» (${daysText(v.days)} ${v.from}–${v.to})`;
  if (list === "tasks") return `задача «${v.text}»${v.due ? ` до ${v.due}` : ""}`;
  if (list === "watch.chats") return `слежу за чатом «${v.query}»${v.kind === "study" ? ` (учёба${v.subject ? `, ${v.subject}` : ""}: ДЗ → study.json)` : ""}`;
  return `стиль: «${v}»`;
}

function normalizeItem(list, value, existing) {
  if (list === "style") return typeof value === "string" ? value.trim() : value?.text;
  if (list === "watch.chats") {
    const o = typeof value === "string" ? { query: value } : value || {};
    return { query: String(o.query || "").trim().replace(/^@/, ""), ...(o.kind !== undefined && o.kind !== "general" ? { kind: o.kind } : {}), ...(o.subject !== undefined ? { subject: o.subject } : {}) };
  }
  const v = { ...(value || {}) };
  if (!v.id) v.id = autoId({ reminders: "r_", schedule: "s_", tasks: "t_" }[list], existing);
  if (list === "reminders") {
    const clean = {};
    for (const f of REMINDER_FIELDS) if (v[f] !== undefined) clean[f] = v[f];
    clean.enabled ??= true;
    clean.work ??= defaultWork(clean);
    if (clean.type === "text" && clean.window === undefined) clean.window = 30;
    if (clean.type === "text" && clean.hidden === undefined) clean.hidden = false;
    return clean;
  }
  if (list === "schedule") return { id: v.id, title: v.title, days: v.days, from: v.from, to: v.to };
  return { id: v.id, text: v.text, important: Boolean(v.important), ...(v.due ? { due: v.due } : {}) };
}

// Применяет набор операций целиком или никак. -> { ok, summary, errors }
export function applyJarvisOps(ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  if (!list.length || list.length > 30) return { ok: false, summary: "", errors: ["нужно от 1 до 30 операций"] };
  const j = JSON.parse(JSON.stringify(loadJarvis()));
  const errors = [];
  const done = [];
  for (const op of list) {
    if (!op || typeof op !== "object") {
      errors.push("операция должна быть объектом");
      continue;
    }
    if (op.op === "set") {
      const check = SET_PATHS[op.path];
      if (!check) {
        errors.push(`путь «${op.path}» менять нельзя. Можно: ${Object.keys(SET_PATHS).join(", ")}`);
        continue;
      }
      const ok = check(op.value);
      if (ok !== true) {
        errors.push(ok);
        continue;
      }
      setPath(j, op.path, op.value);
      done.push(`${op.path} = ${Array.isArray(op.value) ? op.value.join(", ") || "[]" : op.value}`);
      continue;
    }
    if (!["add", "update", "remove"].includes(op.op)) {
      errors.push(`неизвестная операция «${op.op}» (есть set, add, update, remove)`);
      continue;
    }
    if (!LISTS.includes(op.list)) {
      errors.push(`список «${op.list}» не существует. Есть: ${LISTS.join(", ")}`);
      continue;
    }
    const arr = get(j, op.list);
    const key = op.list === "watch.chats" ? "query" : "id";
    const sameKey = (x, id) => String(typeof x === "string" ? x : x[key]).toLowerCase() === String(id).toLowerCase();
    if (op.op === "add") {
      const item = normalizeItem(op.list, op.value, arr);
      const bad =
        op.list === "reminders" ? reminderErrors(item) : op.list === "style" ? (isStr(item, 300) ? [] : ["style: нужна непустая строка"]) : op.list === "watch.chats" ? (isStr(item.query, 100) ? watchChatErrors(item) : ["watch.chats: нужен query"]) : [];
      if (bad.length) {
        errors.push(...bad);
        continue;
      }
      if (op.list !== "style" && arr.some((x) => sameKey(x, item[key]))) {
        errors.push(`${op.list}: «${item[key]}» уже есть (используй update)`);
        continue;
      }
      arr.push(item);
      done.push(`добавил ${describe(op.list, item)}`);
    } else if (op.op === "update") {
      if (op.list === "style" || op.list === "watch.chats") {
        errors.push(`${op.list}: update не поддерживается — remove и add`);
        continue;
      }
      const idx = arr.findIndex((x) => x.id === op.id);
      if (idx === -1) {
        errors.push(`${op.list}: нет записи с id «${op.id}»`);
        continue;
      }
      const patch = { ...(op.value || {}) };
      delete patch.id;
      const merged = normalizeItem(op.list, { ...arr[idx], ...patch }, []);
      if (op.list === "reminders" && patch.type === undefined && patch.work === undefined) merged.work = arr[idx].work ?? merged.work;
      const bad = op.list === "reminders" ? reminderErrors(merged) : [];
      if (bad.length) {
        errors.push(...bad);
        continue;
      }
      arr[idx] = merged;
      done.push(`изменил ${describe(op.list, merged)}`);
    } else {
      const ref = op.id ?? op.value;
      let idx = -1;
      if (op.list === "style") idx = typeof ref === "number" ? ref - 1 : arr.findIndex((s) => s.trim().toLowerCase() === String(ref).trim().toLowerCase());
      else idx = arr.findIndex((x) => sameKey(x, typeof ref === "object" ? ref?.[key] : ref));
      if (idx < 0 || idx >= arr.length) {
        errors.push(`${op.list}: не нашёл «${typeof ref === "object" ? JSON.stringify(ref) : ref}»`);
        continue;
      }
      const [gone] = arr.splice(idx, 1);
      done.push(`убрал ${describe(op.list, gone)}`);
    }
  }
  if (!errors.length) errors.push(...validateJarvis(j));
  if (errors.length) return { ok: false, summary: "", errors };
  saveJarvis(j, "jarvis");
  return { ok: true, summary: done.join("; "), errors: [] };
}

// ---------- маркер [[JARVIS_SET: {...} или [...] ]] ----------
const TAG = "[[JARVIS_SET:";
// Все маркеры с JSON-операциями, которые скрываем от владельца (STUDY — см. study.js).
const HIDDEN_TAGS = [TAG, "[[STUDY:"];

// Балансировка скобок с учётом строк. -> [{ raw, value (объект/массив) | null }]
export function extractJarvisSet(textIn) {
  return extractTagged(textIn, TAG);
}

export function extractTagged(textIn, TAG) {
  const out = [];
  let from = 0;
  while (true) {
    const start = textIn.indexOf(TAG, from);
    if (start === -1) break;
    const open = textIn.slice(start + TAG.length).search(/[{[]/);
    if (open === -1) break;
    const i = start + TAG.length + open;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = i; j < textIn.length; j += 1) {
      const ch = textIn[j];
      if (inStr) {
        if (ch === "\\") j += 1;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if ((ch === "}" || ch === "]") && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    const close = textIn.indexOf("]]", end + 1);
    const rawEnd = close === -1 || textIn.slice(end + 1, close).trim() ? end + 1 : close + 2;
    let value = null;
    try {
      const v = JSON.parse(textIn.slice(i, end + 1));
      if (v && typeof v === "object") value = v;
    } catch {}
    out.push({ raw: textIn.slice(start, rawEnd), value });
    from = rawEnd;
  }
  return out;
}

// Убирает маркеры (в том числе недописанный хвост в стриме).
export function stripJarvisSet(textIn) {
  let out = textIn;
  for (const tag of HIDDEN_TAGS) {
    for (const m of extractTagged(out, tag)) out = out.replace(m.raw, "");
    const at = out.indexOf(tag);
    if (at !== -1) out = out.slice(0, at);
  }
  return out;
}

// ---------- текст для системного промпта ----------
export function jarvisPromptText(j = loadJarvis()) {
  const r = j.rules;
  const off = (a) => (a.length ? a.map((d) => DOW_NAMES[d]).join(", ") : "нет");
  const rem = j.reminders
    .map((x) => `- ${x.id} · ${daysText(x.days)} ${x.time} · ${x.type}${x.type === "task" ? `:${x.task}` : ""}${x.work ? " · работа" : ""}${x.enabled === false ? " · ВЫКЛ" : ""}${x.type === "text" ? ` · «${x.text.slice(0, 50)}»` : ""}`)
    .join("\n");
  const w = j.watch;
  return [
    "## Настройки Джарвиса (файл state/jarvis.json в untra; меняются только маркером [[JARVIS_SET]])",
    `Обращение к владельцу: «${j.address}».`,
    `Стиль (просьбы владельца):\n${j.style.length ? j.style.map((s, i) => `${i + 1}. ${s}`).join("\n") : "—"}`,
    `Правила: тихие часы ${r.quietHours}; работа не позже ${r.noWorkAfter}; без работы: ${off(r.dayOffWork)}; полностью выходной: ${off(r.dayOffAll)}.`,
    `Расписание владельца:\n${j.schedule.map((s) => `- ${s.id} · ${s.title}: ${daysText(s.days)} ${s.from}–${s.to}`).join("\n") || "—"}`,
    `Напоминания (id · дни время · тип):\n${rem || "—"}`,
    `Важные задачи:\n${j.tasks.map((t) => `- ${t.id}${t.important ? " (важно)" : ""}: ${t.text}${t.due ? ` — до ${t.due}` : ""}`).join("\n") || "—"}`,
    `Слежу за чатами: каждые ${w.intervalMin} мин, ${w.from}–${w.to}. Чаты: ${w.chats.map((c) => `${c.query}${c.kind === "study" ? ` [учёба${c.subject ? `:${c.subject}` : ""}]` : ""}`).join(", ") || "нет"}. Важное: ${w.important.join("; ")}.`,
  ].join("\n");
}
