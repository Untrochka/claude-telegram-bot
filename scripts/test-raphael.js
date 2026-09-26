#!/usr/bin/env node
// npm run test:raphael — Рафаэль без Telegram, на временном state.json:
// 1) импорт экспорта Telegram Desktop (офлайн);
// 2) память сессии: факт из первого сообщения помнит во втором;
// 3) «что писал X?» — сам подгружает переписку по имени и отвечает по ней;
// 4) знает, что он внутри бота Азиза;
// 5) интернет: находит свежие данные.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgbot-raphael-"));
process.env.STATE_PATH = path.join(tmp, "state.json");
process.env.DRY_RUN = "true";
if (!process.env.BOT_TOKEN) process.env.BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "111";

const { parseTelegramExport } = await import("../src/importer.js");
const state = await import("../src/state.js");
const { raphaelTurn } = await import("../src/raphael.js");

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) failed += 1;
}

async function ask(text) {
  const reply = await raphaelTurn({ chatKey: "secretary:111", text });
  console.log(`\n> ${text}\n${reply}\n`);
  return reply;
}

// --- 1. Импорт ---
const exportJson = {
  name: "Бахтиёр Малибу",
  type: "personal_chat",
  id: 555,
  messages: [
    { id: 1, type: "message", date_unixtime: "1758000000", from: "Азиз", from_id: "user111", text: "Здравствуйте! Делаю каталоги в Telegram. Могу показать демо." },
    { id: 2, type: "message", date_unixtime: "1758000600", from: "Бахтиёр", from_id: "user555", text: [{ type: "plain", text: "Сколько стоит на 25 товаров? У нас " }, "одежда"] },
    { id: 3, type: "message", date_unixtime: "1758001200", from: "Азиз", from_id: "user111", text: "Catalog Pilot — 2 500 000 сум, до 30 товаров." },
    { id: 4, type: "message", date_unixtime: "1758001800", from: "Бахтиёр", from_id: "user555", text: "Дороговато, бюджет максимум 2 миллиона. Подумаю до пятницы" },
    { id: 5, type: "message", date_unixtime: "1758002000", from: "Бахтиёр", from_id: "user555", photo: "photos/1.jpg", text: "" },
    { id: 6, type: "service", date_unixtime: "1758002100", action: "phone_call" },
  ],
};
const parsed = parseTelegramExport(exportJson, 111);
check("импорт: один чат", parsed.length === 1 && parsed[0].chatId === "555");
check("импорт: роли", parsed[0].messages[0].role === "azizhon" && parsed[0].messages[1].role === "customer");
check("импорт: текст из частей", parsed[0].messages[1].text === "Сколько стоит на 25 товаров? У нас одежда");
check("импорт: фото без текста помечено, служебное пропущено", parsed[0].messages.length === 5 && parsed[0].messages[4].text === "[фото]");
const full = parseTelegramExport({ chats: { list: [exportJson, { ...exportJson, type: "private_group", id: 9 }] } }, 111);
check("импорт: полный экспорт, только личные чаты", full.length === 1);

state.importChatHistory("555", { title: parsed[0].title, messages: parsed[0].messages });
state.setChatMeta("555", { kind: "work" });
state.pushHistory("777", "customer", "Азиз, завтра матеша в 9?");
state.setChatMeta("777", { title: "Сардор @sardor_school", kind: "personal" });
check("импорт: чат виден в /chats", state.listChatSummaries().some((c) => c.chatId === "555" && c.title === "Бахтиёр Малибу"));
check("импорт: засчитано, что Азиз писал", state.hasAzizhonEverReplied("555"));

try {
  // --- 2. Память сессии ---
  await ask("Запомни на этот разговор: мой созвон с барбером Ильёй в четверг в 18:00. Ответь коротко.");
  const recall = await ask("Когда у меня созвон с Ильёй?");
  check("сессия: помнит факт из прошлого сообщения", /четверг/i.test(recall) && /18/.test(recall));

  // --- 3. Чтение переписки по имени ---
  const bakh = await ask("Что писал Бахтиёр и что ему ответить?");
  check("чаты: прочитал переписку (бюджет 2 млн / пятница)", /2\s?(000\s?000|млн|миллион)/i.test(bakh) && /пятниц/i.test(bakh));
  check("чаты: служебные [[CHAT]] не видны Мастеру", !/\[\[CHAT/i.test(bakh));

  // --- 4. Знает, где он ---
  const self = await ask("Кто тебя сделал и где ты работаешь? Одной фразой.");
  check("знает, что он бот Азиза", /азиз|мастер|ты|тобой/i.test(self) && /бот|telegram|телеграм/i.test(self));

  // --- 5. Интернет ---
  const web = await ask("Найди в интернете: какая сейчас последняя стабильная версия Next.js? Коротко, с источником.");
  check("интернет: назвал версию", /\d+\.\d+/.test(web));
} catch (err) {
  console.log(`ОШИБКА: ${err.message}`);
  failed += 1;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} проверок упало.` : "\nВсе проверки прошли.");
process.exit(failed ? 1 : 0);
