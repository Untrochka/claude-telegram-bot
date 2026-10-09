// Стратегии продвижения Азиза (src/strategies/*.md) + его правки поверх них
// (хранятся в state.json, файлы в репо не переписываются). Джарвис, /day и
// агент получают только нужные стратегии, а не все сразу.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getAgentValue, updateAgentValue } from "./state.js";

export const STRATEGIES = {
  overview: "Общий план",
  telegram: "Telegram-канал",
  contra: "Contra и студия",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  instagram: "Instagram",
  comments: "Комментарии",
  schedule: "Расписание",
  clients: "Ответы клиентам (автоответчик)",
  raphael: "Как общается Джарвис",
};

const KEYWORDS = {
  telegram: /канал|тг\b|телеграм|telegram|пост|\/day|рубрик|влог|vlog/i,
  contra: /contra|контр[аеуы]|студи|studio|отклик|pro\b|discovery/i,
  linkedin: /linkedin|линкед|линкдин|коллег/i,
  reddit: /reddit|реддит|showoff/i,
  instagram: /инст|instagram|reels|рилс|сторис|stories/i,
  comments: /коммент|comment/i,
  schedule: /распис|план|сегодня|недел|напомин|когда/i,
  clients: /клиент|автоответ|черновик|ответ[аеу]? /i,
};

function readFile(name) {
  try {
    return fs.readFileSync(path.join(config.strategiesDir, `${name}.md`), "utf8").trim();
  } catch {
    return "";
  }
}

export function strategyNotes(name) {
  return getAgentValue("strategyNotes", {})[name] || [];
}

// Текст стратегии с правками владельца в конце (правки главнее файла).
export function readStrategy(name) {
  const base = readFile(name);
  const notes = strategyNotes(name);
  if (!notes.length) return base;
  const list = notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n");
  return `${base}\n\n## Правки Азиза (важнее текста выше)\n${list}`;
}

// Какие стратегии нужны для этого запроса. overview и правила Джарвиса — всегда.
export function strategiesFor(text, extra = []) {
  const names = new Set(["overview", "raphael", ...extra]);
  for (const [name, re] of Object.entries(KEYWORDS)) if (re.test(text || "")) names.add(name);
  return [...names];
}

export function strategiesBlock(names) {
  return names
    .filter((n) => STRATEGIES[n])
    .map((n) => readStrategy(n))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function addStrategyNote(name, text) {
  if (!STRATEGIES[name]) return false;
  updateAgentValue("strategyNotes", {}, (all) => {
    all[name] = all[name] || [];
    all[name].push({ text: text.trim(), ts: Date.now() });
  });
  return true;
}

export function removeStrategyNote(name, index) {
  return updateAgentValue("strategyNotes", {}, (all) => {
    if (!all[name]?.[index]) return false;
    all[name].splice(index, 1);
    return true;
  });
}

export function strategiesListText() {
  const lines = Object.entries(STRATEGIES).map(([name, label]) => {
    const n = strategyNotes(name).length;
    return `• ${name} — ${label}${n ? ` (правок: ${n})` : ""}`;
  });
  return [
    "Стратегии:",
    ...lines,
    "",
    "Показать: /strategy <имя>, например /strategy contra",
    "Добавить правку: /strategy <имя> + <текст>  (или просто скажи Джарвису)",
    "Удалить правку: /strategy <имя> - <номер>",
  ].join("\n");
}

// Только правки владельца (без текста файла) — для промпта автоответчика.
export function notesText(name) {
  const notes = strategyNotes(name);
  return notes.map((n) => `- ${n.text}`).join("\n");
}
