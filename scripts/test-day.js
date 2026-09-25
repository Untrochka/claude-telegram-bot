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
check("парсер: untra", full.untra.length === 1 && full.untra[0] === "пост untra");
check("парсер: vlog не захватывает NOTES", full.vlog === "пост vlog");
check("парсер: notes", full.notes === "угол: X\nвизуал: видео");

const onlyUntra = parseContentReply("READY_TO_POST\n===UNTRA===\nтолько untra\n===NOTES===\nзаметка");
check("парсер: untra без vlog не захватывает NOTES", onlyUntra.untra[0] === "только untra" && onlyUntra.vlog === null);

const two = parseContentReply("READY_TO_POST\n===UNTRA===\nпервый\n===UNTRA===\nвторой\n===VLOG===\nв");
check("парсер: два поста untra", two.untra.length === 2 && two.untra[1] === "второй" && two.vlog === "в");

const noNotes = parseContentReply("READY_TO_POST\n===UNTRA===\nа\n===VLOG===\nб");
check("парсер: без NOTES", noNotes.untra[0] === "а" && noNotes.vlog === "б" && noNotes.notes === null);

check("парсер: вопрос без маркера", parseContentReply("Что именно кодил?").ready === false);

// --- 2. Живые ходы ---
// Как в bot.js: последние посты канала идут контекстом, не в историю.
function runDialog(recentPostsText) {
  const history = [];
  return async function turn(text) {
    const res = await generateContentReply([{ role: "context", text: recentPostsText }, ...history], text);
    history.push({ role: "azizhon", text }, { role: "assistant", text: res.raw });
    console.log(`\n> ${text}\n${res.raw}\n`);
    return res;
  };
}

try {
  // Сценарий А: расплывчатый ответ — переспрашивает.
  const turnA = runDialog("Последние посты Untra.dev: данных пока нет.");
  const kickoff = await turnA("[СИСТЕМА] Начни сбор материала на сегодня.");
  check("старт: не пост", !kickoff.ready);
  const vague = await turnA("Кодил немного");
  check("расплывчатый ответ: переспрашивает, а не пишет пост", !vague.ready);

  // Сценарий Б: пустой день после 4 нетехнических постов — не выдумывает
  // пост, предлагает мини-эксперименты (текст проверь глазами: senior-уровень).
  console.log("\n===== Сценарий Б: пустой день, лента без техники =====");
  const turnB = runDialog(
    [
      "Последние посты Untra.dev (от старых к новым):",
      "1. (20.09.2026) Написал 30 кофейням за неделю. Ответили двое, и оба не про то, что я ожидал.",
      "2. (21.09.2026) Мне кажется, вайбкодинг — это не про лень, а про то, где ты тратишь внимание.",
      "3. (22.09.2026) Поднял цену на каталог и внезапно стало проще продавать.",
      "4. (23.09.2026) Попробовал Claude в новом режиме и удивился, насколько мало ушло лимита.",
    ].join("\n")
  );
  await turnB("[СИСТЕМА] Начни сбор материала на сегодня.");
  await turnB("Весь день школа и подготовка к универу, ничего не кодил.");
  const empty = await turnB(
    "Реально ничего. Ноут почти не открывал, никому не писал, ничего не ставил. Вечером просто отдыхал."
  );
  check("пустой день: не выдумывает пост для Untra.dev", !empty.ready || empty.untra.length === 0);
} catch (err) {
  console.log(`ОШИБКА вызова модели: ${err.message}`);
  failed += 1;
}

console.log(failed ? `\n${failed} проверок упало.` : "\nВсе проверки прошли.");
process.exit(failed ? 1 : 0);
