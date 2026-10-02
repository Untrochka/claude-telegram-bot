// Хранилище системы untra на сервере: текстовые файлы системы, CRM и журнал действий.
// Всё лежит в DATA_DIR (по умолчанию ./data) — эта папка должна быть постоянным томом в Coolify.
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.UNTRA_DATA_DIR || process.env.DATA_DIR || "data");
export const SYSTEM_DIR = path.join(DATA_DIR, "untra");
export const FILES_DIR = path.join(DATA_DIR, "files");
const CRM_PATH = path.join(DATA_DIR, "crm.json");
const AUDIT_PATH = path.join(DATA_DIR, "audit.jsonl");

const TEXT_EXT = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

function nowTashkent() {
  return new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}
const today = () => nowTashkent().slice(0, 10);

export function audit(who, action, detail) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: nowTashkent(), who, action, ...detail }) + "\n");
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------- файлы системы ----------
function safeSystemPath(rel) {
  const clean = String(rel || "").replace(/^\/+/, "");
  const full = path.resolve(SYSTEM_DIR, clean);
  if (!full.startsWith(SYSTEM_DIR + path.sep)) throw new Error("Путь вне системы untra");
  if (!TEXT_EXT.has(path.extname(full))) throw new Error("Можно только текстовые файлы (.md, .yaml, .txt, .json)");
  return full;
}

export function listSystemFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "archive") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (TEXT_EXT.has(path.extname(e.name))) out.push({ path: path.relative(SYSTEM_DIR, full), bytes: fs.statSync(full).size });
    }
  };
  walk(SYSTEM_DIR);
  return out;
}

export function readSystemFile(rel) {
  return fs.readFileSync(safeSystemPath(rel), "utf-8");
}

export function writeSystemFile(rel, content, who) {
  const full = safeSystemPath(rel);
  if (fs.existsSync(full)) {
    // старая версия сохраняется рядом, чтобы ничего не терялось между ночными бэкапами
    const hist = path.join(DATA_DIR, "history", rel + "." + nowTashkent().replace(/[ :]/g, "-"));
    fs.mkdirSync(path.dirname(hist), { recursive: true });
    fs.copyFileSync(full, hist);
  }
  writeAtomic(full, content);
  audit(who, "write_file", { path: rel, bytes: Buffer.byteLength(content) });
}

// ---------- CRM ----------
export function loadCrm() {
  if (!fs.existsSync(CRM_PATH)) return { leads: [], stoplist: [], daily: [] };
  return JSON.parse(fs.readFileSync(CRM_PATH, "utf-8"));
}
function saveCrm(crm) {
  writeAtomic(CRM_PATH, JSON.stringify(crm, null, 1));
}

export function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/^t\.me\//, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
}

const SEARCH_FIELDS = ["id", "business", "contact", "handle", "link", "note"];

export function crmFind(query, limit = 20) {
  const q = norm(query);
  if (!q) return [];
  const crm = loadCrm();
  return crm.leads.filter((l) => SEARCH_FIELDS.some((f) => norm(l[f]).includes(q))).slice(0, limit);
}

export function crmDup(query) {
  const q = norm(query);
  const crm = loadCrm();
  const leads = crm.leads.filter((l) => ["business", "contact", "handle", "link"].some((f) => q && norm(l[f]) && (norm(l[f]) === q || norm(l[f]).includes(q))));
  const stop = crm.stoplist.filter((s) => Object.values(s).some((v) => q && norm(v).includes(q)));
  return { duplicate: leads.length > 0, do_not_write: stop.length > 0 || leads.some((l) => l.do_not_write), leads, stoplist: stop };
}

const STATUS_BY_ACTION = {
  sent: "Отправлено — не просмотрено",
  reminder: "Напоминание отправлено",
  reply: "Ответил",
  refusal: "Отказ",
  cold: "Холодный",
};

function nextId(crm) {
  const max = crm.leads.reduce((m, l) => Math.max(m, Number(String(l.id).replace(/\D/g, "")) || 0), 0);
  return "C-" + String(max + 1).padStart(3, "0");
}

// Одно действие рассылки: новая отправка, напоминание, ответ, отказ, заметка.
// Находит лида по id / контакту / названию, иначе создаёт нового (только для action=sent).
export function crmLog(event, who) {
  const allowed = ["sent", "reminder", "reply", "refusal", "cold", "note"];
  if (!allowed.includes(event.action)) throw new Error("action должен быть одним из: " + allowed.join(", "));
  const crm = loadCrm();
  let lead = event.id ? crm.leads.find((l) => l.id === event.id) : null;
  if (!lead && event.contact) lead = crm.leads.find((l) => norm(l.contact) === norm(event.contact) || norm(l.handle) === norm(event.contact));
  if (!lead && event.business) lead = crm.leads.find((l) => norm(l.business) === norm(event.business));
  if (!lead) {
    if (event.action !== "sent") throw new Error("Лид не найден. Укажи id, contact или business существующего лида.");
    lead = { id: nextId(crm), first_contact: today() };
    crm.leads.push(lead);
  }
  for (const k of ["business", "contact", "handle", "link", "offer", "segment", "market", "channel", "source"]) {
    if (event[k] && !lead[k]) lead[k] = event[k];
  }
  if (event.summary) lead.summary = event.summary;
  if (event.next_step !== undefined) lead.next_step = event.next_step;
  if (event.next_date !== undefined) lead.next_date = event.next_date;
  if (event.action !== "note") {
    lead.status = event.status || STATUS_BY_ACTION[event.action];
    lead.last_contact = event.date || today();
  }
  if (event.action === "reply") lead.last_signal = event.text || event.summary || lead.last_signal;
  if (event.action === "refusal" || event.action === "cold") {
    lead.do_not_write = true;
    if (event.action === "refusal") {
      crm.stoplist.push({ who: lead.business || lead.contact, contact: lead.contact || lead.handle, reason: event.summary || "Отказ", date: today() });
    }
  }
  if (event.action === "sent" || event.action === "reminder") {
    crm.daily.push({
      date: event.date || today(),
      segment: event.segment || lead.segment || "",
      market: event.market || lead.market || "",
      channel: event.channel || lead.channel || "",
      lead: lead.business || lead.contact,
      status: lead.status,
      crm_id: lead.id,
      type: event.action === "sent" ? "Первое сообщение" : "Напоминание",
    });
  }
  saveCrm(crm);
  audit(who, "crm_log", { action: event.action, id: lead.id });
  return lead;
}

export function crmStatus(date = today()) {
  const crm = loadCrm();
  const rows = crm.daily.filter((d) => String(d.date).slice(0, 10) === date);
  const count = (key) => rows.reduce((acc, r) => ((acc[r[key] || "—"] = (acc[r[key] || "—"] || 0) + 1), acc), {});
  const first = rows.filter((r) => r.type === "Первое сообщение").length;
  return { date, first_messages: first, target: 30, reminders: rows.length - first, by_market: count("market"), by_channel: count("channel"), by_segment: count("segment") };
}

// Кто ответил и ждёт; у кого наступила дата следующего шага.
export function crmWarm() {
  const crm = loadCrm();
  const d = today();
  return crm.leads
    .filter((l) => !l.do_not_write && (/ответ|интерес|ждём|тёпл/i.test(l.status || "") || (l.next_date && String(l.next_date).slice(0, 10) <= d)))
    .map(({ id, business, contact, status, last_signal, next_step, next_date }) => ({ id, business, contact, status, last_signal, next_step, next_date }));
}
