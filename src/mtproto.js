// MTProto: бот работает от имени аккаунта Азиза (userbot, пакет telegram/gramjs).
// Даёт то, чего не умеет Bot API: читать любые его чаты, искать и читать
// публичные каналы без вступления, оставлять комментарии от имени канала.
//
// Безопасность:
// - TG_SESSION = полный доступ к аккаунту. Только в секретах Coolify, никогда
//   в state.json, логах или ответах модели.
// - Любые действия от аккаунта (вступить, отправить) вызываются только из
//   обработчиков кнопок владельца (см. comments.js), с дневными лимитами.
// - DRY_RUN блокирует отправку и вступление.
import { TelegramClient, Api, helpers } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";

let client = null;
let ready = false;
let meId = null;

export class FloodWait extends Error {
  constructor(seconds) {
    super(`Telegram просит подождать ${seconds} с (FLOOD_WAIT)`);
    this.seconds = seconds;
  }
}

export function mtprotoConfigured() {
  return Boolean(config.tgApiId && config.tgApiHash && config.tgSession);
}

export function isMtprotoReady() {
  return ready;
}

// Оборачиваем вызовы: FLOOD_WAIT -> своя ошибка с секундами (вызывающий
// откладывает работу, а не ретраит в цикле).
async function safe(fn) {
  if (!ready) throw new Error("MTProto не подключён");
  try {
    return await fn();
  } catch (err) {
    if (typeof err?.seconds === "number" && /FLOOD/i.test(err.message || err.errorMessage || "")) {
      throw new FloodWait(err.seconds);
    }
    throw err;
  }
}

export async function startMtproto() {
  if (!mtprotoConfigured()) {
    console.log("[mtproto] TG_API_ID/TG_API_HASH/TG_SESSION не заданы — чтение чатов и агент комментариев выключены.");
    return false;
  }
  try {
    client = new TelegramClient(new StringSession(config.tgSession), config.tgApiId, config.tgApiHash, {
      connectionRetries: 5,
      autoReconnect: true,
    });
    client.setLogLevel("error");
    await client.connect();
    if (!(await client.checkAuthorization())) {
      console.error("[mtproto] Сессия недействительна — заново запусти scripts/mtproto-login.js и обнови TG_SESSION.");
      return false;
    }
    const me = await client.getMe();
    meId = me.id.toString();
    ready = true;
    console.log("[mtproto] Подключён к аккаунту владельца.");
    return true;
  } catch (err) {
    console.error("[mtproto] Не удалось подключиться:", err.message);
    return false;
  }
}

// --- Диалоги (кэш на 10 минут, чтобы не дёргать Telegram на каждый вопрос) ---
let dialogsCache = { at: 0, list: [] };

function dialogKind(d) {
  if (d.isUser) return "личный";
  if (d.isChannel && d.entity?.broadcast) return "канал";
  return "группа";
}

async function getDialogs() {
  if (Date.now() - dialogsCache.at < 10 * 60_000 && dialogsCache.list.length) return dialogsCache.list;
  const dialogs = await safe(() => client.getDialogs({ limit: 300 }));
  dialogsCache = {
    at: Date.now(),
    list: dialogs.map((d) => ({
      id: d.id?.toString(),
      title: d.title || d.name || "",
      username: d.entity?.username || "",
      kind: dialogKind(d),
      entity: d.entity,
      date: d.date ? d.date * 1000 : 0,
      unread: d.unreadCount || 0,
    })),
  };
  return dialogsCache.list;
}

export async function findDialogs(query) {
  const q = String(query).trim().replace(/^#/, "").replace(/^@/, "").toLowerCase();
  if (!q) return [];
  const list = await getDialogs();
  const exact = list.filter((d) => d.id === q || d.username.toLowerCase() === q || d.title.toLowerCase() === q);
  if (exact.length) return exact;
  return list.filter((d) => d.title.toLowerCase().includes(q) || d.username.toLowerCase().includes(q));
}

// Короткий список свежих диалогов для системного промпта Рафаэля.
export async function recentDialogsText(n = 15) {
  if (!ready) return "";
  try {
    const list = (await getDialogs()).slice(0, n);
    return list
      .map((d) => `- ${d.title || "без имени"}${d.username ? ` @${d.username}` : ""} (${d.kind}${d.unread ? `, непрочитано ${d.unread}` : ""})`)
      .join("\n");
  } catch (err) {
    console.warn("[mtproto] Не смог получить диалоги:", err.message);
    return "";
  }
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" });
}

function mediaLabel(m) {
  if (m.voice) return "[голосовое]";
  if (m.videoNote) return "[кружок]";
  if (m.photo) return "[фото]";
  if (m.video) return "[видео]";
  if (m.sticker) return "[стикер]";
  if (m.document) return "[файл]";
  return "";
}

function senderName(m, dialog) {
  if (m.out) return "Азиз";
  if (dialog.kind === "личный" || dialog.kind === "канал") return dialog.title || "Собеседник";
  const s = m._sender || m.sender;
  const name = s ? [s.firstName, s.lastName].filter(Boolean).join(" ") || s.title || s.username : "";
  return name || "Участник";
}

// Переписка по имени/@username/id -> текст для модели, или список вариантов.
// -> { transcript } | { options: [..] } | null
export async function readChatByQuery(query, limit = 120, maxChars = 30_000) {
  const found = await findDialogs(query);
  if (!found.length) return null;
  if (found.length > 1 && !found.some((d) => d.title.toLowerCase() === String(query).trim().toLowerCase())) {
    return { options: found.slice(0, 6).map((d) => `${d.title || "без имени"}${d.username ? ` @${d.username}` : ""} (id ${d.id}, ${d.kind})`) };
  }
  const dialog = found.find((d) => d.title.toLowerCase() === String(query).trim().toLowerCase()) || found[0];
  const msgs = await safe(() => client.getMessages(dialog.entity, { limit }));
  const lines = [...msgs]
    .reverse()
    .map((m) => {
      const text = (m.message || "").trim() || mediaLabel(m);
      if (!text) return null;
      return `[${fmtDate(m.date * 1000)}] ${senderName(m, dialog)}: ${text}`;
    })
    .filter(Boolean);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `…(начало обрезано)\n${text.slice(-maxChars)}`;
  return {
    transcript: `Переписка «${dialog.title || "без имени"}» (${dialog.kind}${dialog.username ? `, @${dialog.username}` : ""}), последние сообщения, старые сверху:\n${text || "(пусто)"}`,
  };
}

// --- Публичные каналы (без вступления) ---
export async function searchChannels(q, limit = 20) {
  const res = await safe(() => client.invoke(new Api.contacts.Search({ q, limit })));
  return (res.chats || [])
    .filter((c) => c.className === "Channel" && c.broadcast && c.username)
    .map((c) => ({ username: c.username, title: c.title || "", participants: c.participantsCount || 0 }));
}

export async function channelInfo(username) {
  const full = await safe(() => client.invoke(new Api.channels.GetFullChannel({ channel: username })));
  const fc = full.fullChat;
  return {
    linkedChatId: fc.linkedChatId ? fc.linkedChatId.toString() : null,
    participants: fc.participantsCount || 0,
    about: fc.about || "",
  };
}

export async function channelPosts(username, { limit = 20, minId = 0 } = {}) {
  const msgs = await safe(() => client.getMessages(username, { limit, ...(minId ? { minId } : {}) }));
  return [...msgs]
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id,
      date: (m.date || 0) * 1000,
      text: (m.message || "").trim(),
      views: m.views || 0,
      replies: m.replies ? m.replies.replies || 0 : null,
      hasComments: Boolean(m.replies?.comments),
      hasMedia: Boolean(m.media),
    }))
    .sort((a, b) => a.id - b.id);
}

// --- Отправка комментария (только из кнопки владельца!) ---
// asChannel: true — от имени канала Азиза (config.untraChannelId), false — от него лично.
// canJoin() — колбэк: можно ли сейчас вступить в обсуждение (дневной лимит).
// -> { link, sentAs, joined }
export async function sendComment({ username, postId, text, asChannel, canJoin, onJoined }) {
  if (config.dryRun) throw new Error("DRY_RUN включён — комментарий не отправлен");
  const disc = await safe(() => client.invoke(new Api.messages.GetDiscussionMessage({ peer: username, msgId: postId })));
  const dmsg = disc.messages?.[0];
  if (!dmsg) throw new Error("у поста нет обсуждения (комментарии закрыты)");
  const discPeer = await safe(() => client.getInputEntity(dmsg.peerId));
  let sendAs = asChannel ? await safe(() => client.getInputEntity(config.untraChannelId)) : undefined;
  let joined = false;

  const send = () =>
    safe(() =>
      client.invoke(
        new Api.messages.SendMessage({
          peer: discPeer,
          message: text,
          replyTo: new Api.InputReplyToMessage({ replyToMsgId: dmsg.id }),
          randomId: helpers.generateRandomBigInt(),
          ...(sendAs ? { sendAs } : {}),
        })
      )
    );

  let res;
  try {
    res = await send();
  } catch (err) {
    const msg = err.errorMessage || err.message || "";
    if (/SEND_AS_PEER_INVALID/i.test(msg) && sendAs) {
      sendAs = undefined;
      res = await send();
    } else if (/CHAT_GUEST_SEND_FORBIDDEN|USER_NOT_PARTICIPANT|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE/i.test(msg)) {
      if (!canJoin?.()) throw new Error("нужно вступить в обсуждение, но дневной лимит вступлений исчерпан");
      await safe(() => client.invoke(new Api.channels.JoinChannel({ channel: discPeer })));
      joined = true;
      onJoined?.();
      res = await send();
    } else {
      throw err;
    }
  }

  const upd = (res?.updates || []).find((u) => u.className === "UpdateMessageID" || u.className === "UpdateNewChannelMessage");
  const commentId = upd?.id || upd?.message?.id || null;
  return {
    link: commentId ? `https://t.me/${username}/${postId}?comment=${commentId}` : `https://t.me/${username}/${postId}`,
    sentAs: sendAs ? "channel" : "me",
    joined,
  };
}

export function postLink(username, postId) {
  return `https://t.me/${username}/${postId}`;
}

export function myUserId() {
  return meId;
}
