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

for (const text of MESSAGES) {
  console.log(`\n> ${text}`);
  try {
    const { intent, product, text: modelReply } = await generateReply([], text);

    let finalText = modelReply;
    let note = "";
    if (intent === "refusal" || intent === "soft_no" || intent === "examples") {
      finalText = getTemplate(intent, product) || modelReply;
    } else if (intent === "price") {
      const { ok: priceOk, invalid } = checkPrices(modelReply);
      note = priceOk ? " (цены ок)" : ` (⚠️ вне прайса: ${invalid.join(", ")})`;
    }

    console.log(`  intent=${intent} product=${product}${note}`);
    console.log(`  ответ: ${finalText || "(пусто)"}`);
    ok += 1;
  } catch (err) {
    console.log(`  ОШИБКА вызова модели: ${err.message}`);
    failed += 1;
  }
}

console.log(`\nИтого: ${ok} прогнано, ${failed} ошибок вызова модели из ${MESSAGES.length}.`);
if (failed === MESSAGES.length) {
  console.error(
    "Ни одно сообщение не классифицировано — проверь CLAUDE_MODE в .env (subscription: `claude login`, api: ANTHROPIC_API_KEY)."
  );
  process.exit(1);
}
