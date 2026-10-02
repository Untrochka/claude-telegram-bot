// Ночной бэкап системы untra в приватный GitHub-репозиторий.
// BACKUP_REPO_URL=https://<github-token>@github.com/Untrochka/untra-backup.git
// В бэкап идут: data/untra (система), crm.json, audit.jsonl, history/, files/.
// state.json бота (переписки, черновики) и .env в бэкап НЕ идут.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./store.js";

const run = promisify(execFile);
const WORK = path.join(DATA_DIR, ".backup-repo");
const INCLUDE = ["untra", "crm.json", "audit.jsonl", "history", "files"];
const BACKUP_HOUR = 3; // 03:00 по Ташкенту

async function git(...args) {
  return run("git", ["-C", WORK, ...args], { maxBuffer: 50 * 1024 * 1024 });
}

export async function runBackup(log = console.log) {
  const url = process.env.BACKUP_REPO_URL;
  if (!url) return log("[backup] BACKUP_REPO_URL не задан — пропуск");
  if (!fs.existsSync(path.join(WORK, ".git"))) {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("remote", "add", "origin", url);
    await git("pull", "-q", "origin", "main").catch(() => {}); // пустой репозиторий — нормально
  }
  for (const item of INCLUDE) {
    const src = path.join(DATA_DIR, item);
    const dst = path.join(WORK, item);
    fs.rmSync(dst, { recursive: true, force: true });
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  await git("add", "-A");
  const { stdout } = await git("status", "--porcelain");
  if (!stdout.trim()) return log("[backup] без изменений");
  const stamp = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  await git("-c", "user.name=untra-bot", "-c", "user.email=bot@untra.dev", "commit", "-q", "-m", `backup ${stamp}`);
  await git("push", "-q", "origin", "main");
  log(`[backup] сохранено в GitHub: ${stamp}`);
}

// Первый запуск на новом сервере: если системы ещё нет — взять её из бэкапа.
export async function restoreIfEmpty(log = console.log) {
  const url = process.env.BACKUP_REPO_URL;
  if (!url || fs.existsSync(path.join(DATA_DIR, "untra", "AGENTS.md"))) return;
  fs.rmSync(WORK, { recursive: true, force: true });
  await run("git", ["clone", "-q", url, WORK]);
  for (const item of INCLUDE) {
    const src = path.join(WORK, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(DATA_DIR, item), { recursive: true });
  }
  log("[backup] система восстановлена из бэкапа");
}

let lastDay = null;
export function backupTick(log) {
  const t = new Date(Date.now() + 5 * 3600e3);
  const day = t.toISOString().slice(0, 10);
  if (t.getUTCHours() === BACKUP_HOUR && lastDay !== day) {
    lastDay = day;
    runBackup(log).catch((e) => log("[backup] ошибка: " + e.message.replace(/https:\/\/[^@]+@/g, "https://***@")));
  }
}
