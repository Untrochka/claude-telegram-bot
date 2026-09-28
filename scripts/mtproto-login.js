// Одноразовый вход в твой Telegram-аккаунт для MTProto.
// Запуск (на сервере в контейнере бота или локально):
//   TG_API_ID=12345 TG_API_HASH=abc... node scripts/mtproto-login.js
// API_ID и API_HASH: https://my.telegram.org → API development tools.
// Скрипт спросит телефон, код из Telegram и пароль 2FA (если есть) и выведет
// строку сессии. Положи её в TG_SESSION (секрет в Coolify) и перезапусти бота.
// ВАЖНО: строка сессии = полный доступ к аккаунту. Не отправляй её никому,
// не коммить, не вставляй в чаты (в том числе боту).
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
if (!apiId || !apiHash) {
  console.error("Нужны TG_API_ID и TG_API_HASH (https://my.telegram.org → API development tools).");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
client.setLogLevel("error");

await client.start({
  phoneNumber: () => rl.question("Телефон (+998...): "),
  phoneCode: () => rl.question("Код из Telegram: "),
  password: () => rl.question("Пароль 2FA (если нет — Enter): "),
  onError: (err) => console.error("Ошибка:", err.message),
});

const session = client.session.save();
console.log("\n✅ Вошёл. Строка сессии (скопируй в TG_SESSION, никому не показывай):\n");
console.log(session);
console.log("");
rl.close();
await client.disconnect();
process.exit(0);
