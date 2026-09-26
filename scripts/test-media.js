#!/usr/bin/env node
// npm run test:media — форматирование ответов Рафаэля и разбор медиа без Telegram:
// 1) markdown-lite -> HTML Telegram (офлайн);
// 2) Рафаэль решает задачу — ответ без LaTeX, с разметкой;
// 3) Рафаэль видит картинку;
// 4) видео -> кадры (ffmpeg) -> Рафаэль описывает кадры;
// 5) расшифровка голоса — только если задан GROQ_API_KEY.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Временный state.json — тест не трогает настоящий data/.
process.env.STATE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tgbot-media-")), "state.json");
process.env.DRY_RUN = "true";
if (!process.env.BOT_TOKEN) process.env.BOT_TOKEN = "test-token";
if (!process.env.OWNER_TELEGRAM_ID) process.env.OWNER_TELEGRAM_ID = "1";

const { toTelegramHtml, splitForTelegram } = await import("../src/format.js");
const { raphaelTurn } = await import("../src/raphael.js");
// Каждый вызов — отдельный разговор (новый ключ сессии), как раньше.
let turnNo = 0;
const generateSecretaryReply = (history, text, images = []) =>
  raphaelTurn({ chatKey: `secretary:test${(turnNo += 1)}`, text, images });
const { analyzeVideoBuffer, canTranscribe, transcribeBuffer } = await import("../src/media.js");

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) failed += 1;
}

// --- 1. Форматирование (офлайн) ---
const html = toTelegramHtml(
  "Обозначу катеты *a* и *b*.\n\n**Площадь:**\na² + 3a − 36 = 0\n$$\\frac{a}{2}$$\n- пункт 2 < 3 & 4\n> цитата\n```js\nif (a < b) {}\n```\nsnake_case и a*b*c"
);
check("format: жирный", html.includes("<b>Площадь:</b>"));
check("format: курсив вокруг слов", html.includes("<i>a</i> и <i>b</i>"));
check("format: LaTeX -> code", html.includes("<code>\\frac{a}{2}</code>"));
check("format: экранирование", html.includes("2 &lt; 3 &amp; 4"));
check("format: список", html.includes("• пункт"));
check("format: цитата", html.includes("<blockquote>цитата</blockquote>"));
check("format: блок кода", html.includes('<pre><code class="language-js">if (a &lt; b) {}</code></pre>'));
check("format: snake_case и a*b*c не тронуты", html.includes("snake_case и a*b*c"));

const long = Array.from({ length: 60 }, (_, i) => `Абзац ${i} ${"слово ".repeat(20)}`).join("\n\n");
const chunks = splitForTelegram(`${long}\n\n\`\`\`\ncode\n\`\`\``);
check("split: длинный ответ режется", chunks.length > 1 && chunks.every((c) => c.length <= 4096));

// PNG без зависимостей: слева красный, справа синий
function makePng(w, h) {
  const raw = Buffer.concat(
    Array.from({ length: h }, () =>
      Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, (_, x) => Buffer.from(x < w / 2 ? [255, 0, 0] : [0, 0, 255]))])
    )
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

try {
  // --- 2. Задача: оформление без LaTeX ---
  const math = await generateSecretaryReply(
    [],
    "Реши: в прямоугольном треугольнике один катет на 3 больше другого, площадь 18. Найди гипотенузу."
  );
  console.log(`\n--- Рафаэль, задача (сырой ответ) ---\n${math}\n`);
  check("задача: без LaTeX ($ и \\frac)", !/\$|\\frac|\\sqrt|\\cdot/.test(math));
  check("задача: ответ 9", /9/.test(math));
  check("задача: есть разметка **", /\*\*[^*]+\*\*/.test(math));

  // --- 3. Картинка ---
  const png = makePng(40, 20).toString("base64");
  const img = await generateSecretaryReply([], "[фото] объясни, что тут", [{ mediaType: "image/png", data: png }]);
  console.log(`--- Рафаэль, картинка ---\n${img}\n`);
  check("картинка: видит красный и синий", /красн/i.test(img) && /син/i.test(img));

  // --- 4. Видео ---
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  if (!hasFfmpeg) {
    console.log("SKIP видео: ffmpeg не установлен (в Docker он есть)");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgbot-test-"));
    const video = path.join(dir, "test.mp4");
    spawnSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-shortest", "-pix_fmt", "yuv420p", "-y", video,
    ]);
    const { frames, duration } = await analyzeVideoBuffer(fs.readFileSync(video));
    fs.rmSync(dir, { recursive: true, force: true });
    check(`видео: ${frames.length} кадра, ${duration.toFixed(1)} с`, frames.length === 4 && duration > 3);
    const vid = await generateSecretaryReply(
      [],
      "[видео: 4 кадр(а) приложены как картинки по порядку]\n[звук: речи нет или не распознано]\n[подпись] что на видео?",
      frames
    );
    console.log(`--- Рафаэль, видео ---\n${vid}\n`);
    check("видео: ответ получен", vid.length > 0);
  }

  // --- 5. Голос ---
  if (!canTranscribe()) {
    console.log("SKIP голос: GROQ_API_KEY не задан");
  } else {
    // Реальной речи тут нет — проверяем только, что Groq принимает файл и отвечает.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgbot-test-"));
    const audio = path.join(dir, "a.mp3");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-y", audio]);
    const t = await transcribeBuffer(fs.readFileSync(audio), "a.mp3");
    fs.rmSync(dir, { recursive: true, force: true });
    check(`голос: Groq ответил («${t}»)`, typeof t === "string");
  }
} catch (err) {
  console.log(`ОШИБКА: ${err.message}`);
  failed += 1;
}

console.log(failed ? `\n${failed} проверок упало.` : "\nВсе проверки прошли.");
process.exit(failed ? 1 : 0);
