// Единственный источник списка команд: отсюда берут данные и /help, и меню
// Telegram (setMyCommands). Добавляешь команду — вписываешь её сюда один раз.

// Реальные slash-команды для меню Telegram (setMyCommands). Описание короткое —
// это то, что видно в списке команд под полем ввода.
export const MENU_COMMANDS = [
  { command: "help", description: "Список всех команд с примерами" },
  { command: "auto", description: "Автоответы: статус, on/off" },
  { command: "todo", description: "Задачи: список, добавить, закрыть" },
  { command: "remind", description: "Напоминание через время" },
  { command: "chats", description: "Список клиентских чатов" },
  { command: "chat", description: "Переписка с одним клиентом" },
  { command: "day", description: "Разбор дня для постов в каналы" },
];

// Группы для /help и /start — ровно в этом порядке.
// kind: "command" — реальная команда (как писать + пример);
//       "button" — кнопка в интерфейсе, не команда;
//       "info" — просто пояснение (лимиты, флаги), без ввода текста.
export const HELP_GROUPS = [
  {
    title: "Клиенты и черновики",
    items: [
      {
        kind: "button",
        usage: "✅ Отправить / 🗑 Не отправлять",
        text: "под черновиком ответа клиенту. ✅ — уходит клиенту как есть, 🗑 — черновик удаляется, отвечаешь сам.",
      },
      {
        kind: "button",
        usage: "🗑 Удалить у клиента",
        text: "под карточкой «Отправлено автоматически» — если Telegram дал боту право удалять, можно отменить автоответ.",
      },
      {
        kind: "info",
        usage: "🎤 / 📷 / 🎥 уведомления",
        text: "о голосовом, фото без подписи или видео от клиента — бот сам не отвечает, только сообщает тебе.",
        example: "Придёт: «🎤 Голосовое от клиента в чате 123456 — ответь сам, бот не отвечает.»",
      },
    ],
  },
  {
    title: "Автоответы",
    items: [
      {
        kind: "command",
        usage: "/auto",
        text: "показать, включены ли автоответы, и сколько отправлено сегодня.",
        example: "/auto",
      },
      {
        kind: "command",
        usage: "/auto on",
        text: "включить автоответы.",
        example: "/auto on",
      },
      {
        kind: "command",
        usage: "/auto off",
        text: "выключить автоответы, весь дальнейший ответ — только черновиком.",
        example: "/auto off",
      },
      {
        kind: "info",
        usage: "DRY_RUN=true в .env",
        text: "тестовый режим — автоответы и кнопка ✅ никому ничего не отправляют, только пишут тебе, что было бы отправлено.",
      },
      {
        kind: "info",
        usage: "Лимиты автоответов",
        text: "отправляются только refusal/soft_no/price/examples (см. .env), и только если ты уже писал этому клиенту сам и не писал последние 15 минут. Один и тот же шаблон — максимум раз на чат, всего не больше 2 автоответов на чат в сутки. Отправка идёт с задержкой 60–180 секунд.",
      },
    ],
  },
  {
    title: "Задачи и напоминания",
    items: [
      {
        kind: "command",
        usage: "/todo <текст>",
        text: "добавить задачу.",
        example: "/todo позвонить клиенту завтра",
      },
      {
        kind: "command",
        usage: "/todo",
        text: "показать список открытых задач.",
        example: "/todo",
      },
      {
        kind: "command",
        usage: "/todo done <id>",
        text: "закрыть задачу по номеру.",
        example: "/todo done 3",
      },
      {
        kind: "command",
        usage: "/remind <30m|2h|1d> <текст>",
        text: "напомнить через время (минуты/часы/дни).",
        example: "/remind 2h написать клиенту",
      },
    ],
  },
  {
    title: "Чаты и сводка дня",
    items: [
      {
        kind: "command",
        usage: "/chats",
        text: "список активных клиентских чатов с последним сообщением.",
        example: "/chats",
      },
      {
        kind: "command",
        usage: "/chat <id>",
        text: "загрузить переписку с одним клиентом в контекст, дальше можно спрашивать про неё.",
        example: "/chat 123456789",
      },
      {
        kind: "command",
        usage: "/day",
        text: "начать разбор сегодняшнего дня — бот задаст несколько вопросов и сам соберёт посты для каналов.",
        example: "/day",
      },
      {
        kind: "command",
        usage: "/day stop",
        text: "выйти из режима разбора дня.",
        example: "/day stop",
      },
    ],
  },
];

function formatItem(item) {
  const line = `${item.usage} — ${item.text}`;
  return item.example ? `${line}\nПример: ${item.example}` : line;
}

// Общий текст для /help и /start (для владельца). Собирается из HELP_GROUPS,
// чтобы не держать список команд в двух местах.
export function buildHelpText() {
  const sections = HELP_GROUPS.map((group) => {
    const lines = group.items.map(formatItem).join("\n\n");
    return `━ ${group.title} ━\n${lines}`;
  });
  return sections.join("\n\n");
}
