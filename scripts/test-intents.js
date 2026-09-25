#!/usr/bin/env node
// npm run test:intents — прогоняет заготовленные сообщения через классификатор
// (generateReply -> claude -p / Anthropic API + persona.md) в режиме DRY_RUN
// и печатает intent/product/итоговый текст ответа (шаблон или ответ модели).
// Ничего не отправляет клиентам. chatId здесь не используется вообще —
// generateReply работает без state.js.

process.env.DRY_RUN = "true";
if (!process.env.BOT_TOKEN) process.env.BOT_TOKEN = "test-token";
if (!process.env.OWNER_TELEGRAM_ID) process.env.OWNER_TELEGRAM_ID = "1";

const { generateReply } = await import("../src/claudeClient.js");
const { checkPrices } = await import("../src/prices.js");
const { getTemplate } = await import("../src/templates.js");

// Примеры из CLAUDE_CODE_TASK.md + доп. случаи на все intent/варианты.
const MESSAGES = [
  "Спасибо Но не актуально",
  "Спасибо за предложение. Такой бот у меня уже есть",
  "Спасибо за предложение. Я подумаю)",
  "показывайте примеры и если возможно сразу расценки",
  "Добрый день, напишите пожалуйста по вот этому адресу @nastya_1245",
  "Магазин сейчас закрыт. Откроемся с 10:00 до 20:00",
  "Здравствуйте",
  "Narxi qancha?",
  "Сколько стоит каталог примерно на 20 товаров?",
  "А во сколько обойдётся магазин с оплатой через Click?",
  "Можно посмотреть примеры ваших работ?",
  "Хочу приложение для барбера, покажите демо",
  "Здравствуйте, интересует запись для барбершопа на 3 мастеров",
  "Готов начать, когда можем созвониться?",
  "Это дорого, скидка есть?",
  "Нет времени сейчас, попозже напишу",
  "Assalomu alaykum, narxlar haqida yozing",
  "Пишите по вопросам сотрудничества на @other_manager",
];

let ok = 0;
let failed = 0;
let wrong = 0;

// Образцы «как Азиз пишет сам» — в боте они копятся из его ручных сообщений.
const STYLE = ["ок", "да, гляну вечером", "Здравствуйте! Да, актуально", "не, щас не могу", "хорошо, спасибо"];

async function classify(history, text) {
  const res = await generateReply(history, text, [], { chatName: "Тест", styleSamples: STYLE });
  let finalText = res.text;
  let note = "";
  if (res.intent === "refusal" || res.intent === "soft_no" || res.intent === "examples") {
    finalText = getTemplate(res.intent, res.product) || res.text;
  } else if (res.intent === "price") {
    const { ok: priceOk, invalid } = checkPrices(res.text);
    note = priceOk ? " (цены ок)" : ` (⚠️ вне прайса: ${invalid.join(", ")})`;
  }
  console.log(`  intent=${res.intent} product=${res.product} chat=${res.chat}${note}`);
  console.log(`  ответ: ${finalText || "(пусто)"}`);
  return res;
}

for (const text of MESSAGES) {
  console.log(`\n> ${text}`);
  try {
    await classify([], text);
    ok += 1;
  } catch (err) {
    console.log(`  ОШИБКА вызова модели: ${err.message}`);
    failed += 1;
  }
}

// Случаи со скриншотов владельца: что бот должен понять правильно.
const EXPECT = [
  {
    name: "«Хоп» — подтверждение, не имя",
    history: [
      { role: "customer", text: "Давайте созвонимся завтра" },
      { role: "azizhon", text: "Хорошо, завтра в 15:00 наберу вам" },
    ],
    text: "Хоп",
    check: (r) => r.intent === "ack" && !/хоп[аеу]/i.test(r.text),
  },
  {
    name: "Одноклассник про матешу (пачка) — личный чат",
    history: [],
    text: "Азиз?\nМожно я на свободное место рядом с тобой сяду в матеме?\nНа задних рядах не видно\nИ скучно",
    check: (r) => r.chat === "personal",
  },
  {
    name: "Кот и мотивация — личный чат",
    history: [{ role: "customer", text: "Можно я рядом сяду в матеме?" }, { role: "azizhon", text: "давай" }],
    text: "Когда рядом кот всегда мотивация +1000%",
    check: (r) => r.chat === "personal",
  },
  {
    name: "Клиент отказал на предложение — рабочий чат",
    history: [
      { role: "azizhon", text: "Здравствуйте! Делаю каталоги в Telegram для магазинов. Могу показать демо." },
    ],
    text: "Спасибо, не актуально",
    check: (r) => r.intent === "refusal" && r.chat === "work",
  },
  {
    name: "«Хоп» на предложение демо — согласие, а не имя",
    history: [
      { role: "azizhon", text: "Здравствуйте! Делаю каталоги в Telegram для магазинов. Могу показать демо, если интересно." },
    ],
    text: "Хоп",
    check: (r) => r.intent !== "other" && !/хоп[аеу]|от хоп/i.test(r.text),
  },
  {
    name: "Незнакомец «Здравствуйте» — рабочий, черновик будет",
    history: [],
    text: "Здравствуйте",
    check: (r) => r.chat !== "personal",
  },
  {
    name: "Барбер просит демо — даёт ссылку",
    history: [],
    text: "Хочу приложение для барбера, есть где посмотреть как работает?",
    check: (r) => r.intent === "examples" || /test_barber_reserv_bot/.test(r.text),
  },
  {
    name: "Rahmat — подтверждение",
    history: [{ role: "azizhon", text: "Demo: https://t.me/test_barber_reserv_bot" }],
    text: "Rahmat",
    check: (r) => r.intent === "ack",
  },
];

console.log("\n===== Ожидаемые результаты =====");
for (const c of EXPECT) {
  console.log(`\n> ${c.name}\n  «${c.text.replace(/\n/g, " / ")}»`);
  try {
    const r = await classify(c.history, c.text);
    const good = c.check(r);
    console.log(`  ${good ? "OK" : "FAIL"}`);
    if (!good) wrong += 1;
  } catch (err) {
    console.log(`  ОШИБКА вызова модели: ${err.message}`);
    failed += 1;
  }
}

console.log(`\nИтого: ${ok} прогнано, ${failed} ошибок вызова модели, ${wrong} неверных из ${EXPECT.length} ожидаемых.`);
if (failed === MESSAGES.length + EXPECT.length) {
  console.error(
    "Ни одно сообщение не классифицировано — проверь CLAUDE_MODE в .env (subscription: `claude login`, api: ANTHROPIC_API_KEY)."
  );
}
process.exit(failed || wrong ? 1 : 0);
