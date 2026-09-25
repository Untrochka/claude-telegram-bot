// Ответы Рафаэля (секретаря) пишутся в упрощённом markdown, а Telegram
// понимает только свой HTML-поднабор: <b> <i> <s> <u> <code> <pre>
// <blockquote> <a>. Здесь — перевод одного в другое без внешних библиотек.
// LaTeX Telegram не рисует: персона просит формулы в Unicode, а если
// модель всё же прислала $...$ — показываем содержимое моноширинным.

const TG_LIMIT = 4096;
const CHUNK_LIMIT = 3500; // запас: после перевода в HTML текст растёт за счёт тегов

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInline(line) {
  return line
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, "<u>$1</u>")
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "<s>$1</s>")
    // *курсив* / _курсив_ — только вокруг слов, чтобы не ломать a*b и snake_case
    .replace(/(^|[\s(«"])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s).,:;!?»"])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(«"])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s).,:;!?»"])/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => `<a href="${url.replace(/"/g, "&quot;")}">${text}</a>`);
}

// Markdown-lite -> Telegram HTML. Вход — сырой текст модели.
export function toTelegramHtml(md) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;

  let text = md.replace(/\r\n/g, "\n");

  // 1. Блоки кода ```lang ... ```
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const body = escapeHtml(code.replace(/\n$/, ""));
    return keep(lang ? `<pre><code class="language-${lang}">${body}</code></pre>` : `<pre>${body}</pre>`);
  });
  // 2. LaTeX на всякий случай: $$...$$ и $...$ -> моноширинный текст
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, f) => keep(`<code>${escapeHtml(f.trim())}</code>`));
  text = text.replace(/\$([^$\n]+?)\$/g, (m, f) => keep(`<code>${escapeHtml(f.trim())}</code>`));
  // 3. Инлайн-код
  text = text.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${escapeHtml(code)}</code>`));

  // 4. Остальное экранируем и размечаем построчно
  const out = [];
  let quote = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };

  for (const rawLine of escapeHtml(text).split("\n")) {
    const quoteMatch = rawLine.match(/^&gt;\s?(.*)$/);
    if (quoteMatch) {
      quote.push(formatInline(quoteMatch[1]));
      continue;
    }
    flushQuote();
    const heading = rawLine.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      out.push(`<b>${formatInline(heading[1])}</b>`);
      continue;
    }
    // "* пункт" / "- пункт" -> "• пункт" (Telegram не рисует списки)
    const bullet = rawLine.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${formatInline(bullet[2])}`);
      continue;
    }
    out.push(formatInline(rawLine));
  }
  flushQuote();

  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)]);
}

// Режет длинный ответ на части по абзацам, не разрывая блоки ``` .
export function splitForTelegram(md, limit = CHUNK_LIMIT) {
  if (md.length <= limit) return [md];
  const paragraphs = md.split(/\n{2,}/);
  const chunks = [];
  let current = "";
  let inFence = false;

  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    const fences = (p.match(/```/g) || []).length;
    if (candidate.length > limit && current && !inFence) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
    if (fences % 2 === 1) inFence = !inFence;
  }
  if (current) chunks.push(current);

  // Абзац длиннее лимита — режем грубо по строкам/символам
  return chunks.flatMap((c) => {
    if (c.length <= TG_LIMIT - 500) return [c];
    const parts = [];
    for (let i = 0; i < c.length; i += limit) parts.push(c.slice(i, i + limit));
    return parts;
  });
}
