// Живая связь бота с системой untra: когда Claude/GPT меняют файлы через коннектор,
// бот сам пересобирает прайс (persona.md, prices.js), знания (knowledge.md) и стратегии.
// То же, что делает untra/build.py --bot, только на JS и прямо на сервере.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_DIR } from "./store.js";
import { setAllowedPrices } from "../prices.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Мини-парсер YAML ровно под формат core/offer.yaml: верхние ключи, вложенные
// "ключ: {a: 1, b: "x"}", списки "- текст" и "ключ: значение". Комментарии "#".
function scalar(v) {
  v = v.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) return splitTop(v.slice(1, -1)).map(scalar);
  return v;
}
function splitTop(s) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") q = ch;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function flowMap(s) {
  const obj = {};
  for (const part of splitTop(s.trim().slice(1, -1))) {
    const i = part.indexOf(":");
    obj[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
  }
  return obj;
}
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}
export function parseOffer(text) {
  const root = {};
  let top = null;
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      const i = t.indexOf(":");
      top = t.slice(0, i).trim();
      const rest = t.slice(i + 1).trim();
      root[top] = rest ? scalar(rest) : null;
      continue;
    }
    if (t.startsWith("- ")) {
      if (!Array.isArray(root[top])) root[top] = [];
      root[top].push(scalar(t.slice(2)));
      continue;
    }
    const i = t.indexOf(":");
    const key = t.slice(0, i).trim();
    const rest = t.slice(i + 1).trim();
    if (!root[top] || Array.isArray(root[top])) root[top] = {};
    root[top][key] = rest.startsWith("{") ? flowMap(rest) : scalar(rest);
  }
  return root;
}

const money = (v, cur) => (cur === "uz" ? v.toLocaleString("ru-RU").replace(/ /g, " ") + " сум" : "$" + v.toLocaleString("en-US"));
function priceLine(it, cur) {
  if (it.custom) return cur === "en" ? "индивидуально (EN: цену не называть, передать Азизу)" : "индивидуально";
  if (it.price != null) return money(it.price, cur);
  if (it.setup != null) return `${money(it.setup, cur)} запуск + ${money(it.monthly, cur)}/мес.`;
  if (it.monthly != null) return `${money(it.monthly, cur)}/мес.`;
  if (it.monthly_from != null) return `${money(it.monthly_from, cur)}–${money(it.monthly_to, cur)}/мес.`;
  if (it.to != null) return `${money(it.from, cur)}–${money(it.to, cur)}`;
  return "от " + money(it.from, cur);
}
export function offerMd(offer, markets = ["uz", "en"]) {
  const titles = { uz: "Узбекистан (сум)", en: "International (USD)" };
  const out = [];
  for (const m of markets) {
    out.push(`**${titles[m]}**`);
    for (const it of Object.values(offer[m] || {})) out.push(`- ${it.name}: ${priceLine(it, m)}${it.what ? " — " + it.what : ""}`);
    out.push("");
  }
  const p = offer.payment || {};
  out.push("**Оплата**");
  out.push(`- Мелкий местный проект: ${p.small_local}.`);
  out.push(`- Крупный или зарубежный: ${p.large_or_foreign}.`);
  out.push(`- Скидка на тот же объём — максимум ${p.max_discount_pct}%. Если дорого — ${p.low_budget}.`);
  if (p.price_lock) out.push(`- ${p.price_lock[0].toUpperCase()}${p.price_lock.slice(1)}.`);
  out.push("- Бесплатно не делаем: " + (offer.never_free || []).join(", ") + ".");
  out.push("- Не обещать: " + (offer.limits || []).join("; ") + ".");
  return out.join("\n");
}
export function allowedUzPrices(offer) {
  const vals = new Set();
  for (const it of Object.values(offer.uz || {})) for (const k of ["price", "from", "to", "setup", "monthly"]) if (typeof it[k] === "number") vals.add(it[k]);
  return [...vals].sort((a, b) => a - b);
}

const read = (rel) => fs.readFileSync(path.join(SYSTEM_DIR, rel), "utf8").trim();
const tryRead = (rel) => { try { return read(rel); } catch { return ""; } };

function replaceBlock(file, body) {
  const text = fs.readFileSync(file, "utf8");
  const re = /<!-- UNTRA:BEGIN -->[\s\S]*?<!-- UNTRA:END -->/;
  if (!re.test(text)) throw new Error(`нет маркеров UNTRA в ${path.basename(file)}`);
  fs.writeFileSync(file, text.replace(re, () => `<!-- UNTRA:BEGIN -->\n${body}\n<!-- UNTRA:END -->`));
}

export function syncFromSystem() {
  if (!fs.existsSync(path.join(SYSTEM_DIR, "core", "offer.yaml"))) return false;
  const offer = parseOffer(read("core/offer.yaml"));
  const prices = allowedUzPrices(offer);
  if (!prices.length) throw new Error("в offer.yaml не нашлось цен uz — бот оставил старые");
  replaceBlock(
    path.join(SRC, "persona.md"),
    "## Прайс (используй только эти цифры, ничего не добавляй)\n\n" + offerMd(offer, ["uz"]) +
      "\n\nСлова «каталог», «Mini App», «админка» клиенту не писать. Если клиент пишет на английском или упоминает Contra — цену не называй, передай Азизхону."
  );
  replaceBlock(
    path.join(SRC, "knowledge.md"),
    [tryRead("core/me.md"), tryRead("core/north-star.md"), "# Сейчас (state/NOW.md)\n\n" + tryRead("state/NOW.md"),
      "# Прайс\n\n" + offerMd(offer), tryRead("playbooks/learning.md"), tryRead("playbooks/health.md")].filter(Boolean).join("\n\n")
  );
  const strat = path.join(SRC, "strategies");
  fs.writeFileSync(path.join(strat, "overview.md"), [tryRead("core/north-star.md"), tryRead("core/scenarios.md")].join("\n\n") + "\n");
  for (const [name, pb] of [["contra", "contra"], ["linkedin", "linkedin"], ["reddit", "reddit"], ["telegram", "tg-posts"]]) {
    const t = tryRead(`playbooks/${pb}.md`);
    if (t) fs.writeFileSync(path.join(strat, `${name}.md`), t + "\n");
  }
  setAllowedPrices(prices);
  return true;
}

function systemMtime() {
  let max = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else max = Math.max(max, fs.statSync(f).mtimeMs);
    }
  };
  walk(SYSTEM_DIR);
  return max;
}

let lastSeen = 0;
export function liveTick(log = console.log) {
  const m = systemMtime();
  if (!m || m === lastSeen) return;
  lastSeen = m;
  try {
    if (syncFromSystem()) log("[untra] прайс, знания и стратегии обновлены из системы");
  } catch (e) {
    log("[untra] не удалось обновить из системы: " + e.message);
  }
}
