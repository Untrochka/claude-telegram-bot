// MCP-сервер «untra»: дверь для Claude и ChatGPT к системе и CRM на этом сервере.
// Протокол: MCP Streamable HTTP (JSON-RPC через POST), ответы обычным JSON, без зависимостей.
// Доступ: секретный адрес https://<домен>/<MCP_TOKEN>/mcp. Отдельный токен на каждого клиента:
// MCP_TOKENS="claude:длинныйсекрет,gpt:другойсекрет". Отозвать доступ — убрать токен и перезапустить.
// Через эту дверь нельзя отправлять сообщения клиентам и нельзя удалять — только данные.
import http from "node:http";
import * as store from "./store.js";

const PROTOCOL = "2025-06-18";

function parseTokens() {
  const map = new Map();
  for (const pair of String(process.env.MCP_TOKENS || "").split(",")) {
    const [who, token] = pair.split(":").map((s) => s && s.trim());
    if (who && token && token.length >= 24) map.set(token, who);
  }
  return map;
}

const str = (description) => ({ type: "string", description });

const TOOLS = [
  {
    name: "start_here",
    description: "Вызывай первым в каждом разговоре: правила системы (AGENTS.md), текущее состояние (state/NOW.md) и цель (core/north-star.md).",
    inputSchema: { type: "object", properties: {} },
    run: () => ["AGENTS.md", "state/NOW.md", "core/north-star.md"].map((p) => `===== ${p}\n${safeRead(p)}`).join("\n\n"),
  },
  {
    name: "list_files",
    description: "Список текстовых файлов системы untra (core/, playbooks/, state/).",
    inputSchema: { type: "object", properties: {} },
    run: () => store.listSystemFiles(),
  },
  {
    name: "read_file",
    description: "Прочитать файл системы untra, например core/offer.yaml или playbooks/contra.md.",
    inputSchema: { type: "object", properties: { path: str("Путь внутри системы") }, required: ["path"] },
    run: (a) => store.readSystemFile(a.path),
  },
  {
    name: "write_file",
    description: "Перезаписать файл системы целиком (старая версия сохраняется в истории). Сначала прочитай файл. Правило меняется в одном файле, а не копируется.",
    inputSchema: { type: "object", properties: { path: str("Путь внутри системы"), content: str("Полное новое содержимое") }, required: ["path", "content"] },
    run: (a, who) => (store.writeSystemFile(a.path, a.content, who), `Сохранено: ${a.path}`),
  },
  {
    name: "crm_find",
    description: "Найти лидов в CRM по названию, @нику, email, ссылке или ID.",
    inputSchema: { type: "object", properties: { query: str("Что искать") }, required: ["query"] },
    run: (a) => store.crmFind(a.query),
  },
  {
    name: "crm_dup",
    description: "Проверка перед любым контактом: есть ли уже такой лид и не в стоп-листе ли он.",
    inputSchema: { type: "object", properties: { query: str("Название, @ник, email или сайт") }, required: ["query"] },
    run: (a) => store.crmDup(a.query),
  },
  {
    name: "crm_log",
    description:
      "Записать действие ПОСЛЕ того, как Азиз или ты реально отправили сообщение: sent (первое сообщение, создаёт лида), reminder, reply (клиент ответил), refusal (отказ → стоп-лист), cold (молчит после напоминания), note.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sent", "reminder", "reply", "refusal", "cold", "note"] },
        id: str("ID лида, если известен (C-123)"),
        business: str("Название бизнеса"),
        contact: str("@ник или email"),
        link: str("Сайт или канал"),
        offer: str("Что предложили"),
        segment: str("сайт / магазин в Telegram / бот записи / web app"),
        market: { type: "string", enum: ["UZ", "EN"] },
        channel: { type: "string", enum: ["Telegram", "Email", "LinkedIn", "Contra", "Instagram", "Другое"] },
        source: str("Откуда лид"),
        summary: str("Коротко, что произошло"),
        text: str("Текст ответа клиента (для reply)"),
        next_step: str("Следующий шаг"),
        next_date: str("Дата следующего шага, ГГГГ-ММ-ДД"),
      },
      required: ["action"],
    },
    run: (a, who) => store.crmLog(a, who),
  },
  {
    name: "crm_status",
    description: "Сколько первых сообщений и напоминаний за день, по рынкам, каналам и сегментам.",
    inputSchema: { type: "object", properties: { date: str("ГГГГ-ММ-ДД, по умолчанию сегодня") } },
    run: (a) => store.crmStatus(a.date || undefined),
  },
  {
    name: "crm_warm",
    description: "Тёплые лиды и те, у кого сегодня или раньше наступила дата следующего шага.",
    inputSchema: { type: "object", properties: {} },
    run: () => store.crmWarm(),
  },
];

function safeRead(p) {
  try {
    return store.readSystemFile(p);
  } catch {
    return "(файла нет)";
  }
}

const SERVER_INFO = { name: "untra", version: "1.0.0" };
const INSTRUCTIONS =
  "Система Азиза (Untra). Сначала вызови start_here. Цены — только из core/offer.yaml. Перед любым контактом — crm_dup. " +
  "Клиентам от имени Азиза ничего не отправлять без его прямой просьбы. В конце работы обнови state/NOW.md (write_file).";

async function handleRpc(msg, who) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    return ok({ protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return fail(-32602, "Нет такого инструмента");
    try {
      const res = await tool.run(params.arguments || {}, who);
      const text = typeof res === "string" ? res : JSON.stringify(res, null, 1);
      store.audit(who, "tool", { tool: tool.name });
      return ok({ content: [{ type: "text", text }] });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "Ошибка: " + e.message }], isError: true });
    }
  }
  if (id === undefined) return null; // уведомления (notifications/*) — без ответа
  return fail(-32601, "Метод не поддерживается");
}

export function startMcpServer({ port = Number(process.env.MCP_PORT || 8787), log = console.log } = {}) {
  const tokens = parseTokens();
  if (!tokens.size) {
    log("[mcp] MCP_TOKENS не задан — дверь для Claude/GPT выключена");
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return res.writeHead(200).end("ok");
    const m = url.pathname.match(/^\/([^/]+)\/mcp\/?$/);
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const who = (m && tokens.get(m[1])) || tokens.get(bearer);
    if (!who) return res.writeHead(404).end();
    if (req.method !== "POST") return res.writeHead(405, { Allow: "POST" }).end();
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return res.writeHead(413).end();
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(batch.map((m) => handleRpc(m, who)))).filter(Boolean);
    if (!out.length) return res.writeHead(202).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
  });
  server.listen(port, () => log(`[mcp] untra MCP слушает порт ${port}, клиентов: ${[...tokens.values()].join(", ")}`));
  return server;
}
