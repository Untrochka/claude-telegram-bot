#!/usr/bin/env node
// npm run test:day — проверка режима /day без Telegram и без публикации:
// 1) парсер READY_TO_POST на заготовленных ответах (офлайн);
// 2) пара живых ходов через content-persona.md: на расплывчатый ответ
//    агент должен переспрашивать, а не сразу писать пост.

process.env.DRY_RUN = "true";
if (!process.env.BOT_TOKEN) process.env.BOT_TOKEN = "test-token";
if (!process.env.OWNER_TELEGRAM_ID) process.env.OWNER_TELEGRAM_ID = "1";

const { generateContentReply, parseContentReply } = await import("../src/claudeClient.js");

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) failed += 1;
}

// --- 1. Парсер ---
const full = parseContentReply(
  "READY_TO_POST\n===UNTRA===\nпост untra\n===VLOG===\nпост vlog\n===NOTES===\nугол: X\nвизуал: видео"
);
check("парсер: untra", full.untra === "пост untra");
check("парсер: vlog не захватывает NOTES", full.vlog === "пост vlog");
check("парсер: notes", full.notes === "угол: X\nвизуал: видео");

const onlyUntra = parseContentReply("READY_TO_POST\n===UNTRA===\nтолько untra\n===NOTES===\nзаметка");
check("парсер: untra без vlog не захватывает NOTES", onlyUntra.untra === "только untra" && onlyUntra.vlog === null);

const noNotes = parseContentReply("READY_TO_POST\n===UNTRA===\nа\n===VLOG===\nб");
check("парсер: без NOTES", noNotes.untra === "а" && noNotes.vlog === "б" && noNotes.notes === null);

check("парсер: вопрос без маркера", parseContentReply("Что именно кодил?").ready === false);

// --- 2. Живые ходы ---
const history = [];
async function turn(text) {
  const res = await generateContentReply(history, text);
  history.push({ role: "azizhon", text }, { role: "assistant", text: res.raw });
  console.log(`\n> ${text}\n${res.raw}\n`);
  return res;
}

try {
  const kickoff = await turn("[СИСТЕМА] Начни сбор материала на сегодня.");
  check("старт: не пост", !kickoff.ready);

  const vague = await turn("Кодил немного");
  check("расплывчатый ответ: переспрашивает, а не пишет пост", !vague.ready);
} catch (err) {
  console.log(`ОШИБКА вызова модели: ${err.message}`);
  failed += 1;
}

console.log(failed ? `\n${failed} проверок упало.` : "\nВсе проверки прошли.");
process.exit(failed ? 1 : 0);
