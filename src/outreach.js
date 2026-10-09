// Работа с клиентскими чатами пачкой — всё тяжёлое делает код, модели идут короткие данные.
//
// 1) scan_clients: папка Telegram «Клиенты» → по каждому чату последние 2–3 сообщения
//    и «прочитано ли наше» → статус по таблице → сравнение с CRM. Чаты без изменений
//    с прошлого скана (тот же последний id и то же «прочитано») не читаются вообще.
//    Джарвису — один компактный блок; карточку CRM_BATCH бот сам шлёт Мастеру.
// 2) [[CRM_BATCH: [...] ]] — пачка записей в CRM одной карточкой ✅/🗑.
// 3) [[SEND_QUEUE: [...] ]] — очередь личных сообщений от аккаунта Мастера после ✅:
//    пауза 40–90 с, crm_dup перед каждым, crm_log после, стоп на FLOOD/PEER_FLOOD,
//    прогресс правкой одного сообщения, /stop_queue — отмена.
import { config } from "./config.js";
import { sendMessage, sendMessageWithButtons, editMessageText, sendMessageQuiet, editMessageQuiet } from "./telegram.js";
import { createDraft, getDraft, deleteDraft, getAgentValue, setAgentValue, updateAgentValue, getDailyCount, incDailyCount } from "./state.js";
import { loadCrm, crmLog, crmDup, norm } from "./untra/store.js";
import { isMtprotoReady, getFolderPeers, peerDialogsInfo, lastMessages, sendDirect, FloodWait } from "./mtproto.js";

export const DEFAULT_FOLDER = "Клиенты";
const MAX_BATCH = 100;
const MAX_QUEUE = 60;
const DM_DAILY_MAX = Number(process.env.MAX_DMS_PER_DAY || 25); // правило рассылки: ≤ 25 в день
const MSG_PAUSE_MS = 400; // между чтениями чатов
const FLOOD_WAIT_MAX_S = 300; // дольше — останавливаем скан и отдаём что успели

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Статусы ----------
export const STATUS = {
  refusal: "Отказ",
  auto: "Автоответ",
  waiting: "Ждёт нашего ответа",
  notSent: "Не отправлено",
  unread: "Отправлено — не просмотрено",
  seen: "Просмотрено — без ответа",
  cold: "Холодный",
};

const REFUSAL_PHRASES = [
  "не нужно", "не надо", "не интересно", "неинтересно", "нам не нужно", "пока не надо", "пока не нужно",
  "спасибо, нет", "спасибо нет", "уже есть", "не актуально", "неактуально",
  "kerak emas", "kerakmas", "shart emas", "hozircha yo'q", "hozircha yoq", "qiziq emas", "qiziqmas",
];
const AUTOREPLY_PHRASES = [
  "спасибо за обращение", "ответим в ближайшее время", "мы свяжемся", "свяжемся с вами", "ваше сообщение получено",
  "xabaringiz uchun rahmat", "murojaatingiz uchun rahmat", "tez orada javob beramiz", "tez orada bog'lanamiz",
];
const lower = (t) => String(t || "").toLowerCase().replace(/[ʻʼ‘’`]/g, "'");
export const isRefusalText = (t) => REFUSAL_PHRASES.some((p) => lower(t).includes(p));
export const isAutoreplyText = (t) => AUTOREPLY_PHRASES.some((p) => lower(t).includes(p));

// Рабочие дни (пн–пт) между датой «ГГГГ-ММ-ДД…» и сегодня по Ташкенту.
export function workdaysSince(dateStr, now = Date.now()) {
  const d = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const start = new Date(`${d}T00:00:00Z`);
  const end = new Date(new Date(now + 5 * 3600e3).toISOString().slice(0, 10) + "T00:00:00Z");
  let n = 0;
  for (let t = new Date(start.getTime() + 86400e3); t <= end; t = new Date(t.getTime() + 86400e3)) {
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

// Статус чата по таблице (первое совпадение сверху).
// msgs — последние сообщения, новые сверху; lastOut — наше последнее (может быть старше msgs).
export function classifyChat({ isBot = false, msgs = [], lastOut = null, readOutboxMaxId = 0, lead = null, now = Date.now() }) {
  const incoming = msgs.filter((m) => !m.out && (!lastOut || m.id > lastOut.id));
  const theirLast = incoming[0] || null;
  if (theirLast && isRefusalText(incoming.map((m) => m.text).join("\n"))) return STATUS.refusal;
  if (theirLast) {
    const oldestNew = incoming[incoming.length - 1];
    const fast = lastOut && oldestNew.date - lastOut.date >= 0 && oldestNew.date - lastOut.date < 10_000;
    if (isBot || theirLast.viaBot || fast || isAutoreplyText(theirLast.text)) return STATUS.auto;
    return STATUS.waiting;
  }
  if (!lastOut) return STATUS.notSent;
  if (lastOut.id > readOutboxMaxId) return STATUS.unread;
  if (lead && /напомин/i.test(lead.status || "") && workdaysSince(lead.last_contact, now) >= 3) return STATUS.cold;
  return STATUS.seen;
}

// ---------- Сопоставление с CRM ----------
export function matchLead(leads, chat) {
  const u = norm(chat.username);
  if (u) {
    const byHandle = leads.find((l) => ["handle", "contact", "link"].some((f) => norm(l[f]) === u));
    if (byHandle) return byHandle;
  }
  const id = String(chat.id || "");
  if (id) {
    const byId = leads.find((l) => ["handle", "contact", "link"].some((f) => norm(l[f]) === id));
    if (byId) return byId;
  }
  const t = norm(chat.title);
  if (t) return leads.find((l) => norm(l.business) === t || norm(l.contact) === t) || null;
  return null;
}

const ddmm = (ms) => new Date(ms).toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit" });
const oneLine = (t, n) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// Запись CRM_LOG для изменившегося статуса (или нового чата вне CRM).
export function crmEventFor(chat, status, lead, theirText = "") {
  const who = lead ? { id: lead.id } : { contact: chat.username ? `@${chat.username}` : chat.id, handle: chat.username ? `@${chat.username}` : "", business: chat.title || "", channel: "Telegram" };
  const t = oneLine(theirText, 60);
  if (status === STATUS.refusal) return { action: "refusal", ...who, summary: t ? `Отказ: «${t}»` : "Отказ" };
  if (status === STATUS.cold) return { action: "cold", ...who, summary: "3 раб. дня после напоминания без ответа" };
  if (!lead) return { action: "sent", no_daily: true, ...who, status, summary: `Из папки, не из рассылки · ${status}` };
  if (status === STATUS.waiting) return { action: "reply", ...who, status, summary: t ? `Написал: «${t}»` : "Написал, ждёт ответа", text: oneLine(theirText, 300) };
  return { action: "note", ...who, status, summary: `Сверка: ${lead.status || "—"} → ${status}` };
}

// FLOOD_WAIT: короткий — ждём и повторяем один раз; длинный — наверх.
async function withFlood(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FloodWait && err.seconds <= FLOOD_WAIT_MAX_S) {
      await sleep((err.seconds + 1) * 1000);
      return fn();
    }
    throw err;
  }
}

// ---------- Скан папки ----------
// -> { text: блок для Джарвиса/Мастера, batch: [CRM_LOG-объекты] }
export async function scanClients(folder = DEFAULT_FOLDER, { onStatus } = {}) {
  if (!isMtprotoReady()) return { text: "scan_clients: MTProto не подключён — скан невозможен.", batch: [] };
  const name = String(folder || "").trim() || DEFAULT_FOLDER;
  const f = await withFlood(() => getFolderPeers(name));
  if (f.error) return { text: `scan_clients: ${f.error}`, batch: [] };
  if (!f.peers.length) return { text: `scan_clients: в папке «${f.title}» нет чатов, добавленных вручную${f.byFlags ? " (папка собрана флагами вроде «все контакты» — такие не читаю)" : ""}.`, batch: [] };

  onStatus?.(`🔎 Папка «${f.title}»: ${f.peers.length} чатов…`);
  const dialogs = await withFlood(() => peerDialogsInfo(f.peers));
  const cache = getAgentValue("scanCache", {});
  const leads = loadCrm().leads;

  let unchanged = 0;
  let statusChanged = 0;
  let notInCrm = 0;
  let stoppedAt = null;
  const lines = [];
  const batch = [];
  const nextCache = { ...cache };

  for (const d of dialogs) {
    const prev = cache[d.id];
    if (prev && prev.top === d.topId && prev.read === d.readOutboxMaxId) {
      unchanged += 1;
      continue;
    }
    let info;
    try {
      info = await withFlood(() => lastMessages(d.inputPeer, 3));
    } catch (err) {
      stoppedAt = `${err.message} — остановился, прочитал ${dialogs.indexOf(d)} из ${dialogs.length}`;
      break;
    }
    await sleep(MSG_PAUSE_MS);
    const lead = matchLead(leads, d);
    const status = classifyChat({ isBot: d.isBot, msgs: info.msgs, lastOut: info.lastOut, readOutboxMaxId: d.readOutboxMaxId, lead });
    const theirLast = info.msgs.find((m) => !m.out && (!info.lastOut || m.id > info.lastOut.id));
    nextCache[d.id] = { top: d.topId, read: d.readOutboxMaxId, status };

    if (!lead) notInCrm += 1;
    else if (lead.status !== status) statusChanged += 1;
    if (!lead || lead.status !== status) batch.push(crmEventFor(d, status, lead, theirLast?.text));

    if ((status === STATUS.waiting || status === STATUS.refusal) && theirLast) {
      lines.push(`${status === STATUS.refusal ? "✖" : "•"} ${lead?.id || "нет в CRM"} | ${d.username ? `@${d.username}` : d.id} | ${oneLine(d.title, 40)} | ${ddmm(theirLast.date)} «${oneLine(theirLast.text, 120)}»`);
    }
  }
  setAgentValue("scanCache", nextCache);

  const head = `scan_clients «${f.title}»: всего ${dialogs.length} · без изменений ${unchanged} · изменился статус ${statusChanged} · нет в CRM ${notInCrm}`;
  const parts = [head];
  if (f.byFlags) parts.push("(в папке есть чаты по флагам — их не читал, только добавленные вручную)");
  if (stoppedAt) parts.push(`⚠️ ${stoppedAt}`);
  parts.push(lines.length ? `Ждут ответа (•) и отказы (✖):\n${lines.join("\n")}` : "Ждущих ответа и отказов нет.");
  return { text: parts.join("\n"), batch: batch.slice(0, MAX_BATCH), batchTotal: batch.length };
}

// Скан для Мастера/Джарвиса: карточку CRM_BATCH бот шлёт сам, Джарвису — только блок.
export async function runScanForOwner(chatId, folder, { onStatus } = {}) {
  let res;
  try {
    res = await scanClients(folder, { onStatus });
  } catch (err) {
    return `scan_clients: ошибка — ${err.message}`;
  }
  let tail = "";
  if (res.batch.length) {
    await sendCrmBatchCard(chatId, res.batch);
    tail = `\nCRM_BATCH: ${res.batch.length} записей${res.batchTotal > res.batch.length ? ` (из ${res.batchTotal}, остальные — следующим сканом)` : ""} — карточка уже у Мастера на ✅, сам не пересобирай.`;
  } else tail = "\nCRM менять не нужно.";
  return res.text + tail;
}

// ---------- Маркеры с JSON-массивом: [[NAME: [ ... ] ]] ----------
// Скобки считаем с учётом строк, поэтому «]» внутри текста сообщения не ломает разбор.
export function extractJsonMarkers(text, name) {
  const out = [];
  const tag = `[[${name}:`;
  let from = 0;
  while (true) {
    const start = text.indexOf(tag, from);
    if (start === -1) break;
    let i = text.indexOf("[", start + tag.length);
    if (i === -1) break;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (ch === "\\") j += 1;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    const close = text.indexOf("]]", end + 1);
    const rawEnd = close === -1 ? end + 1 : close + 2;
    let value = null;
    try {
      value = JSON.parse(text.slice(i, end + 1));
    } catch {}
    out.push({ raw: text.slice(start, rawEnd), value: Array.isArray(value) ? value : null });
    from = rawEnd;
  }
  return out;
}

export function stripJsonMarkers(text, names = ["CRM_BATCH", "SEND_QUEUE"]) {
  let out = text;
  for (const n of names) for (const m of extractJsonMarkers(out, n)) out = out.replace(m.raw, "");
  // Недописанный маркер в стриме — прячем хвост.
  for (const n of names) {
    const at = out.indexOf(`[[${n}:`);
    if (at !== -1) out = out.slice(0, at);
  }
  return out;
}

// ---------- CRM_BATCH ----------
const batchLine = (e) => `${e.id || e.contact || e.business || "?"} · ${e.action}${e.status ? ` (${e.status})` : ""} · ${oneLine(e.summary || "", 60)}`;

export async function sendCrmBatchCard(chatId, items) {
  const list = items.filter((e) => e && typeof e === "object" && e.action).slice(0, MAX_BATCH);
  if (!list.length) return sendMessage(chatId, "CRM_BATCH пустой или битый — ничего не записываю.");
  const id = createDraft({ kind: "crm_batch", items: list });
  const shown = [];
  let size = 0;
  for (const e of list) {
    const l = batchLine(e);
    if (size + l.length > 3300) break;
    shown.push(l);
    size += l.length + 1;
  }
  const more = list.length - shown.length;
  await sendMessageWithButtons(chatId, `🗂 CRM: ${list.length} записей\n${shown.join("\n")}${more ? `\n…и ещё ${more}` : ""}`, [
    [
      { text: `✅ Записать все (${list.length})`, callback_data: `cb:y:${id}` },
      { text: "🗑 Не надо", callback_data: `cb:n:${id}` },
    ],
  ]);
}

export async function handleCrmBatchCallback(query, action, id) {
  const d = getDraft(id);
  if (!d) return "Уже не актуально.";
  deleteDraft(id);
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const text = (query.message.text || "").slice(0, 3000);
  if (action !== "y") {
    await editMessageText(chatId, msgId, `${text}\n\n🗑 Не записывал.`);
    return "Ок";
  }
  let ok = 0;
  const errors = [];
  for (const e of d.items) {
    try {
      crmLog(e, "raphael batch (✅ Мастер)");
      ok += 1;
    } catch (err) {
      errors.push(`${e.id || e.contact || e.business || "?"}: ${err.message}`);
    }
  }
  await editMessageQuiet(chatId, msgId, `${text}\n\n✅ Записано ${ok} из ${d.items.length}.`);
  await sendMessage(chatId, `CRM_BATCH: ок ${ok}, ошибок ${errors.length}${errors.length ? `\n${errors.slice(0, 15).join("\n")}` : ""}`);
  return "Записал";
}

// ---------- SEND_QUEUE ----------
let running = null; // { cancel: bool }

export function queueRunning() {
  return Boolean(running);
}

export async function sendQueueCard(chatId, items) {
  const list = items.filter((x) => x && x.to && typeof x.text === "string" && x.text.trim()).slice(0, MAX_QUEUE);
  if (!list.length) return sendMessage(chatId, "SEND_QUEUE пустой или битый — ничего не отправляю.");
  const id = createDraft({ kind: "send_queue", items: list });
  const first = list
    .slice(0, 3)
    .map((x, i) => `${i + 1}) ${x.to}\n${x.text.slice(0, 900)}`)
    .join("\n\n");
  const left = Math.max(0, DM_DAILY_MAX - getDailyCount("dm"));
  const note = list.length > left ? `\n\nСегодня можно ещё ${left} (лимит ${DM_DAILY_MAX} в день) — остальные останутся на завтра.` : "";
  await sendMessageWithButtons(chatId, `📤 Очередь: ${list.length} сообщений от твоего аккаунта, пауза 40–90 с.\n\n${first}${list.length > 3 ? `\n\n…и ещё ${list.length - 3}` : ""}${note}`, [
    [
      { text: `✅ Отправить (${list.length})`, callback_data: `sq:y:${id}` },
      { text: "📄 Показать все", callback_data: `sq:all:${id}` },
    ],
    [{ text: "🗑 Не надо", callback_data: `sq:n:${id}` }],
  ]);
}

export async function handleSendQueueCallback(query, action, id) {
  const d = getDraft(id);
  if (!d) return "Уже не актуально.";
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const text = (query.message.text || "").slice(0, 3500);
  if (action === "all") {
    let chunk = "";
    for (const [i, x] of d.items.entries()) {
      const part = `${i + 1}) ${x.to}\n${x.text}\n\n`;
      if (chunk.length + part.length > 3800) {
        await sendMessageQuiet(chatId, chunk);
        chunk = "";
      }
      chunk += part;
    }
    if (chunk) await sendMessageQuiet(chatId, chunk);
    return "Показал";
  }
  deleteDraft(id);
  if (action !== "y") {
    await editMessageQuiet(chatId, msgId, `${text}\n\n🗑 Не отправлял.`);
    return "Ок";
  }
  if (running) return "Уже идёт другая очередь — дождись или /stop_queue";
  if (config.dryRun) {
    await editMessageQuiet(chatId, msgId, `${text}\n\n⚠️ DRY_RUN включён — ничего не отправлено.`);
    return "DRY_RUN";
  }
  await editMessageQuiet(chatId, msgId, `${text}\n\n▶️ Запустил.`);
  const progress = await sendMessageQuiet(chatId, `📤 Очередь: 0 из ${d.items.length}…`);
  runQueue(chatId, progress.message_id, d.items).catch((err) => console.error("[outreach] Очередь упала:", err.message));
  return "Отправляю";
}

export function stopQueue() {
  if (!running) return false;
  running.cancel = true;
  return true;
}

async function pauseOrCancel(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (running?.cancel) return false;
    await sleep(Math.min(1000, until - Date.now()));
  }
  return !running?.cancel;
}

async function runQueue(chatId, progressId, items) {
  running = { cancel: false };
  let sent = 0;
  let skipped = 0;
  const errors = [];
  let stopReason = "";
  let i = 0;
  const who = (x) => String(x.to);
  const progress = async (extra = "") => {
    try {
      await editMessageQuiet(chatId, progressId, `📤 Очередь: ${i} из ${items.length} · ушло ${sent} · пропущено ${skipped} · ошибок ${errors.length}${extra ? `\n${extra}` : ""}\n/stop_queue — отменить`);
    } catch {}
  };
  try {
    for (; i < items.length; i += 1) {
      if (running.cancel) {
        stopReason = "отменено /stop_queue";
        break;
      }
      if (getDailyCount("dm") >= DM_DAILY_MAX) {
        stopReason = `дневной лимит ${DM_DAILY_MAX} — остальное завтра`;
        break;
      }
      const x = items[i];
      const dup = crmDup(String(x.to));
      const firstContact = !x.crm || x.crm.action === "sent";
      if (dup.do_not_write || (firstContact && dup.duplicate)) {
        skipped += 1;
        await progress(`⏭ ${who(x)} — ${dup.do_not_write ? "do_not_write" : "уже есть в CRM"}`);
        continue;
      }
      try {
        await sendDirect(x.to, x.text);
        sent += 1;
        incDailyCount("dm");
      } catch (err) {
        const msg = err.errorMessage || err.message || "";
        if (err instanceof FloodWait || /FLOOD/i.test(msg)) {
          stopReason = /PEER_FLOOD/i.test(msg) ? "PEER_FLOOD — Telegram ограничил отправку незнакомым" : msg;
          break;
        }
        errors.push(`${who(x)}: ${msg.slice(0, 80)}`);
        await progress();
        continue;
      }
      if (x.crm) {
        try {
          crmLog({ ...x.crm, contact: x.crm.contact || (x.crm.id ? undefined : String(x.to)) }, "send_queue (✅ Мастер)");
        } catch (err) {
          errors.push(`${who(x)} CRM: ${err.message.slice(0, 80)}`);
        }
      }
      await progress();
      if (i < items.length - 1 && !(await pauseOrCancel(40_000 + Math.random() * 50_000))) {
        i += 1;
        stopReason = "отменено /stop_queue";
        break;
      }
    }
  } finally {
    running = null;
  }
  const rest = items.slice(i).map(who);
  await progress(stopReason ? `⛔ ${stopReason}` : "✅ Готово");
  setAgentValue("sendQueueLast", { at: Date.now(), sent, skipped, errors, rest });
  // Одна строка — она же уходит в журнал Джарвиса (без текстов сообщений).
  await sendMessage(
    chatId,
    `Очередь: ушло ${sent} / пропущено ${skipped} / ошибки ${errors.length}${stopReason ? ` · стоп: ${stopReason}` : ""}${rest.length ? ` · не отправлено ${rest.length}: ${rest.slice(0, 20).join(", ")}${rest.length > 20 ? "…" : ""}` : ""}${errors.length ? `\nОшибки: ${errors.slice(0, 5).join("; ")}` : ""}`
  );
}
