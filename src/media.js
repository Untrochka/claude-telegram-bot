// Голосовые, фото и видео -> то, что понимает Claude: текст расшифровки
// и картинки (base64). Claude сам не слушает звук, поэтому голос идёт через
// Groq Whisper (GROQ_API_KEY), а видео режется ffmpeg на несколько кадров
// + звуковую дорожку. Всё, что пришло от клиента, — чужой ввод: сюда он
// попадает только как данные для модели без инструментов.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { getFile, downloadFile, MAX_DOWNLOAD_BYTES } from "./telegram.js";

// Claude принимает картинку до ~5 МБ в base64 — берём с запасом.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const VIDEO_FRAMES = 4;
const FFMPEG_TIMEOUT_MS = 60_000;

export class MediaError extends Error {}

async function download(fileId, knownSize) {
  if (knownSize && knownSize > MAX_DOWNLOAD_BYTES) {
    throw new MediaError("файл больше 20 МБ — Telegram не даёт ботам скачивать такие");
  }
  const file = await getFile(fileId);
  if (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES) {
    throw new MediaError("файл больше 20 МБ — Telegram не даёт ботам скачивать такие");
  }
  return { buffer: await downloadFile(file.file_path), filePath: file.file_path };
}

// --- Голос -> текст (Groq Whisper, OpenAI-совместимый API) ---

export function canTranscribe() {
  return Boolean(config.groqApiKey);
}

export async function transcribeBuffer(buffer, filename) {
  if (!config.groqApiKey) throw new MediaError("GROQ_API_KEY не задан — голос расшифровать нечем");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", config.groqWhisperModel);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Groq: ${data.error?.message || `HTTP ${res.status}`}`);
  return (data.text || "").trim();
}

// voice (.oga) и кружки/аудио. Groq понимает ogg/opus, mp3, mp4, m4a, wav, webm.
export async function transcribeTelegramAudio(fileId, fileSize) {
  const { buffer, filePath } = await download(fileId, fileSize);
  const ext = path.extname(filePath).toLowerCase();
  const filename = ext === ".oga" || !ext ? "voice.ogg" : `audio${ext}`;
  return transcribeBuffer(buffer, filename);
}

// --- Фото ---

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

// msg.photo — массив размеров; берём самый большой, влезающий в лимит Claude.
export async function imageFromPhotoSizes(sizes) {
  const fitting = sizes.filter((s) => !s.file_size || s.file_size <= MAX_IMAGE_BYTES);
  const best = (fitting.length ? fitting : sizes)[(fitting.length ? fitting : sizes).length - 1];
  const { buffer } = await download(best.file_id, best.file_size);
  if (buffer.length > MAX_IMAGE_BYTES) throw new MediaError("картинка слишком большая");
  return { mediaType: "image/jpeg", data: buffer.toString("base64") };
}

// Картинка, присланная файлом (document с mime image/*).
export async function imageFromDocument(doc) {
  const { buffer, filePath } = await download(doc.file_id, doc.file_size);
  if (buffer.length > MAX_IMAGE_BYTES) throw new MediaError("картинка слишком большая (больше 4 МБ)");
  const mediaType = IMAGE_TYPES[path.extname(filePath).toLowerCase()] || doc.mime_type;
  if (!Object.values(IMAGE_TYPES).includes(mediaType)) throw new MediaError(`формат ${mediaType} не поддерживается`);
  return { mediaType, data: buffer.toString("base64") };
}

// --- Видео -> кадры + расшифровка звука (ffmpeg) ---

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new MediaError(`${cmd} не установлен на сервере`) : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} завершился с кодом ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// Работает с буфером видео напрямую (удобно для тестов без Telegram).
export async function analyzeVideoBuffer(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgbot-video-"));
  try {
    const input = path.join(dir, "input.mp4");
    fs.writeFileSync(input, buffer);

    const duration = Number(
      await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input])
    ) || 0;

    // Кадры равномерно по длине ролика (не с самого края).
    const frames = [];
    for (let i = 0; i < VIDEO_FRAMES; i += 1) {
      const t = duration > 0 ? (duration * (i + 0.5)) / VIDEO_FRAMES : 0;
      const out = path.join(dir, `frame${i}.jpg`);
      try {
        await run("ffmpeg", ["-v", "error", "-ss", t.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", "-y", out]);
        if (fs.existsSync(out)) frames.push({ mediaType: "image/jpeg", data: fs.readFileSync(out).toString("base64") });
      } catch (err) {
        if (err instanceof MediaError) throw err;
        // один кадр не вытащился — не страшно
      }
      if (duration === 0) break; // длительность неизвестна — хватит одного кадра
    }

    // Звук: моно 16 кГц mp3 — маленький и Whisper его понимает.
    let transcript = "";
    let transcriptError = "";
    if (canTranscribe()) {
      const audio = path.join(dir, "audio.mp3");
      try {
        await run("ffmpeg", ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", audio]);
        transcript = await transcribeBuffer(fs.readFileSync(audio), "audio.mp3");
      } catch (err) {
        // у видео может не быть звука — это нормально
        transcriptError = err.message;
      }
    } else {
      transcriptError = "GROQ_API_KEY не задан";
    }

    return { frames, transcript, transcriptError, duration };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function analyzeTelegramVideo(fileId, fileSize) {
  const { buffer } = await download(fileId, fileSize);
  return analyzeVideoBuffer(buffer);
}

// --- Общая точка: любое сообщение -> { text, images, kind } ---
// kind — для карточек и логов ("voice" | "video_note" | "video" | "photo" | "image_file" | null).
// text — то, что пойдёт модели вместо текста сообщения (с пометкой, откуда он).
export async function extractMedia(msg) {
  const caption = (msg.caption || "").trim();

  if (msg.voice || msg.audio) {
    const media = msg.voice || msg.audio;
    const transcript = await transcribeTelegramAudio(media.file_id, media.file_size);
    return {
      kind: "voice",
      transcript,
      text: `[голосовое, расшифровка] ${transcript || "(ничего не распознано)"}${caption ? `\n[подпись] ${caption}` : ""}`,
      images: [],
    };
  }

  if (msg.video_note || msg.video || msg.animation) {
    const media = msg.video_note || msg.video || msg.animation;
    const kind = msg.video_note ? "video_note" : "video";
    const { frames, transcript } = await analyzeTelegramVideo(media.file_id, media.file_size);
    const label = kind === "video_note" ? "кружок" : "видео";
    const parts = [`[${label}: ${frames.length} кадр(а) приложены как картинки по порядку]`];
    parts.push(transcript ? `[звук, расшифровка] ${transcript}` : "[звук: речи нет или не распознано]");
    if (caption) parts.push(`[подпись] ${caption}`);
    return { kind, transcript, text: parts.join("\n"), images: frames };
  }

  if (msg.photo) {
    const image = await imageFromPhotoSizes(msg.photo);
    return { kind: "photo", text: caption ? `[фото] ${caption}` : "[фото без подписи]", images: [image] };
  }

  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    const image = await imageFromDocument(msg.document);
    return { kind: "image_file", text: caption ? `[картинка файлом] ${caption}` : "[картинка файлом без подписи]", images: [image] };
  }

  return null;
}

// Есть ли в сообщении то, что extractMedia умеет разобрать.
export function hasMedia(msg) {
  return Boolean(
    msg.voice ||
      msg.audio ||
      msg.video_note ||
      msg.video ||
      msg.animation ||
      msg.photo ||
      (msg.document && /^image\//.test(msg.document.mime_type || ""))
  );
}
