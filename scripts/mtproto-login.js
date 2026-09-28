// Одноразовый вход в твой Telegram-аккаунт для MTProto.
// Запуск (на сервере в контейнере бота или локально):
//   TG_API_ID=12345 TG_API_HASH=abc... node scripts/mtproto-login.js        — по коду
//   TG_API_ID=12345 TG_API_HASH=abc... node scripts/mtproto-login.js --qr   — без кода, по QR
// Если код не приходит (Telegram иногда не шлёт коды на вход с серверов) — используй --qr:
// скрипт покажет QR-код, отсканируй его в Telegram на телефоне:
// Настройки → Устройства → Подключить устройство. QR рисуется через `npx qrcode-terminal`
// (временный запуск, в зависимости проекта не добавляется); если npx недоступен —
// печатается ссылка tg://login, из неё можно сделать QR любым способом на своём компьютере.
// API_ID и API_HASH: https://my.telegram.org → API development tools.
// Скрипт спросит телефон, код из Telegram и пароль 2FA (если есть) и выведет
// строку сессии. Положи её в TG_SESSION (секрет в Coolify) и перезапусти бота.
// ВАЖНО: строка сессии = полный доступ к аккаунту. Не отправляй её никому,
// не коммить, не вставляй в чаты (в том числе боту).
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
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

const useQr = process.argv.includes("--qr");

if (useQr) {
  await client.connect();
  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async ({ token, expires }) => {
        const url = `tg://login?token=${token.toString("base64url")}`;
        const secs = Math.max(0, expires - Math.floor(Date.now() / 1000));
        console.log(`\nОтсканируй QR в Telegram: Настройки → Устройства → Подключить устройство (действует ~${secs} с, потом появится новый):\n`);
        // CLI qrcode-terminal читает текст из stdin, если это не терминал.
        const r = spawnSync("npx", ["-y", "qrcode-terminal@0.12.0"], { input: `${url}\n`, stdio: ["pipe", "inherit", "inherit"] });
        if (r.status !== 0) console.log("(не смог нарисовать QR через npx)");
        console.log(`\nСсылка для входа (если QR не рисуется): ${url}\n`);
      },
      password: async () => rl.question("Пароль 2FA (облачный пароль): "),
      onError: async (err) => {
        console.error("Ошибка:", err.message);
        return false;
      },
    }
  );
} else {
  await client.start({
    phoneNumber: () => rl.question("Телефон (+998...): "),
    phoneCode: () => rl.question("Код из Telegram: "),
    password: () => rl.question("Пароль 2FA (если нет — Enter): "),
    onError: (err) => console.error("Ошибка:", err.message),
  });
}

const session = client.session.save();
console.log("\n✅ Вошёл. Строка сессии (скопируй в TG_SESSION, никому не показывай):\n");
console.log(session);
console.log("");
rl.close();
await client.disconnect();
process.exit(0);
