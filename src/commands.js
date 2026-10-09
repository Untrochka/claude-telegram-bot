// Единственный источник списка команд: отсюда берут данные и /help, и меню
// Telegram (setMyCommands). Добавляешь команду — вписываешь её сюда один раз.

// Реальные slash-команды для меню Telegram (setMyCommands). Описание короткое —
// это то, что видно в списке команд под полем ввода.
export const MENU_COMMANDS = [
  { command: "help", description: "Все команды + быстрые кнопки" },
  { command: "plan", description: "План на сегодня по площадкам" },
  { command: "todo", description: "[текст] | done [№] — задачи (кнопки)" },
  { command: "remind", description: "[30m|2h|1d] [текст] — напомнить" },
  { command: "chats", description: "Клиентские чаты — открыть кнопкой" },
  { command: "chat", description: "[имя|id] — разобрать переписку" },
  { command: "scan_clients", description: "[папка] — статусы всех клиентских чатов" },
  { command: "stop_queue", description: "Остановить очередь рассылки" },
  { command: "auto", description: "[on|off] — автоответы клиентам" },
  { command: "comments", description: "[check|on|off] — агент комментариев" },
  { command: "watch", description: "[find|reset|add @канал|remove @канал]" },
  { command: "reddit", description: "Найти вопросы на Reddit сейчас" },
  { command: "day", description: "Разбор дня для постов в каналы" },
  { command: "stop", description: "Выйти из разбора дня" },
  { command: "remember", description: "[факт] — запомнить надолго" },
  { command: "memory", description: "Что помню (удалить кнопкой)" },
  { command: "forget", description: "[№] — забыть факт" },
  { command: "strategy", description: "[имя] [+ правка] — стратегии" },
  { command: "model", description: "[роль] [low…max] — effort Opus 5.5" },
  { command: "new", description: "Джарвис: начать разговор заново" },
];

// --- Кнопки вместо набора аргументов ---
// m:<команда> — бот выполняет команду так, будто ты её написал;
// m:?<команда> — бот спрашивает недостающий текст, следующее сообщение
// дописывается к команде. callback_data у Telegram — максимум 64 байта.
export function cmdBtn(text, command) {
  return { text, callback_data: `m:${command}`.slice(0, 64) };
}

export function askBtn(text, command) {
  return { text, callback_data: `m:?${command}`.slice(0, 64) };
}

export function grid(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

// Что спросить, когда команде не хватает текста.
export function askPrompt(command) {
  if (command === "/todo") return "Напиши задачу одним сообщением.";
  if (command === "/remind") return "Когда и что? Например: «2h позвонить Ильясу», «30 минут выпить воды», «1d отправить счёт».";
  if (command === "/remember") return "Что запомнить? Одним сообщением.";
  if (command === "/watch add") return "Пришли @канал или ссылку t.me/…";
  if (command === "/chat") return "Имя или id чата?";
  const st = command.match(/^\/strategy (\w+) \+$/);
  if (st) return `Напиши правку к стратегии «${st[1]}» — одной фразой, как надо делать впредь.`;
  return "Напиши, что добавить к команде.";
}

// Быстрые кнопки под /start и /help.
export const QUICK_MENU = [
  [cmdBtn("📅 План", "/plan"), cmdBtn("✅ Задачи", "/todo"), askBtn("⏰ Напомнить", "/remind")],
  [cmdBtn("💬 Чаты", "/chats"), cmdBtn("🤖 Автоответы", "/auto"), cmdBtn("🧠 Память", "/memory")],
  [cmdBtn("✍️ Комменты", "/comments"), cmdBtn("📡 Каналы", "/watch"), cmdBtn("🟠 Reddit", "/reddit")],
  [cmdBtn("📝 Разбор дня", "/day"), cmdBtn("🎯 Стратегии", "/strategy"), cmdBtn("⚙️ Effort", "/model")],
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
        usage: "✅ Отправить / ✏️ Переписать / 🗑",
        text: "под черновиком ответа клиенту. ✅ — уходит клиенту как есть, ✏️ — пишешь, что поменять, и бот присылает новую версию, 🗑 — черновик удаляется, отвечаешь сам.",
      },
      {
        kind: "info",
        usage: "Правка ответом (reply)",
        text: "ответь на любую карточку (клиент, пост, комментарий, Reddit) тем, что поменять — бот перепишет. Или просто скажи Джарвису «измени ответ клиенту, слишком иишно». Правки запоминаются.",
        example: "reply на карточку: «проще и без ссылки»",
      },
      {
        kind: "info",
        usage: "Правила насовсем",
        text: "скажи Джарвису, как делать впредь («пиши клиентам без «с радостью»», «отвечай мне короче») — он предложит сохранить правило кнопкой. Код менять не нужно. Список правил — /strategy clients, /strategy raphael.",
      },
      {
        kind: "info",
        usage: "Когда приходит черновик",
        text: "бот ждёт ~40 секунд после последнего сообщения и делает один черновик на всю пачку. Если ты ответил сам за это время — черновика не будет.",
      },
      {
        kind: "info",
        usage: "Когда черновика нет",
        text: "на «ок», «хоп», «рахмат», 👍 и в личных чатах (друзья, одноклассники) — бот молчит, Telegram и так покажет сообщение.",
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
        text: "отправляются только refusal/soft_no/price/examples (см. .env), только в рабочих чатах, только если ты уже писал этому клиенту сам и не писал последние 15 минут. Один и тот же шаблон — максимум раз на чат, всего не больше 2 автоответов на чат в сутки. Отправка идёт с задержкой 60–180 секунд.",
      },
    ],
  },
  {
    title: "Джарвис и память",
    items: [
      {
        kind: "info",
        usage: "Просто пиши",
        text: "Джарвис помнит весь разговор, знает твои проекты, видит все чаты бота и сам читает нужную переписку. Может искать в интернете.",
        example: "что мне писал Бахтиёр про цену и что ему ответить?",
      },
      {
        kind: "info",
        usage: "Джарвис делает сам",
        text: "скажи словами — он сам поставит задачу, напоминание, запомнит, найдёт каналы, проверит посты, включит/выключит автоответы или агента, сменит модель, начнёт /day. Простые фразы («план на сегодня», «найди каналы», «напомни через 2 часа …», «запомни: …») бот выполняет сразу, без Claude.",
        example: "поставь задачу позвонить Константину и выключи автоответы",
      },
      {
        kind: "command",
        usage: "/new",
        text: "начать разговор с Джарвисом заново (долгая память и чаты остаются).",
        example: "/new",
      },
      {
        kind: "command",
        usage: "/remember <факт>",
        text: "запомнить надолго — будут знать Джарвис и /day.",
        example: "/remember созвон с Малибу перенесли на пятницу",
      },
      {
        kind: "command",
        usage: "/memory, /forget <номер>",
        text: "посмотреть, что бот помнит, и удалить лишнее.",
        example: "/forget 2",
      },
    ],
  },
  {
    title: "Агент: посты и комментарии",
    items: [
      {
        kind: "info",
        usage: "Напоминания",
        text: "по расписанию из стратегий: пост в Untra.dev (Вт/Чт/Сб), пост на Contra (готовлю английскую версию), комментарии на Contra и LinkedIn, Reddit, утренняя сводка в 11:00, отчёт в воскресенье. Кнопки: ✅ Сделал / ⏰ Позже / 🙅 Пропускаю.",
      },
      {
        kind: "command",
        usage: "/plan",
        text: "что сегодня по плану на всех площадках.",
        example: "/plan",
      },
      {
        kind: "info",
        usage: "Комментарии в Telegram",
        text: "сам ищу каналы, слежу за новыми постами и присылаю черновик комментария: ✅ от канала / 👤 от тебя / ✏️ переписать / 🗑. Без твоей кнопки ничего не уходит. Лимиты на день — защита аккаунта.",
      },
      {
        kind: "command",
        usage: "/comments, /comments check, /comments on|off",
        text: "статус агента, проверить каналы сейчас, включить/выключить.",
        example: "/comments check",
      },
      {
        kind: "command",
        usage: "/watch, /watch find, /watch reset, /watch add @канал, /watch remove @канал",
        text: "список каналов, поиск новых сейчас, reset — убрать найденные автоматически и искать заново, добавить/убрать вручную. Ищу русскоязычные каналы СНГ и англоязычные.",
        example: "/watch find",
      },
      {
        kind: "command",
        usage: "/reddit",
        text: "найти свежие вопросы на Reddit и написать черновики ответов (отвечаешь сам по ссылке).",
        example: "/reddit",
      },
      {
        kind: "command",
        usage: "/strategy, /strategy <имя>, /strategy <имя> + <правка>",
        text: "стратегии площадок и твои правки к ним. Проще — просто скажи Джарвису «теперь на Contra 4 поста в неделю», он предложит сохранить.",
        example: "/strategy contra",
      },
      {
        kind: "command",
        usage: "/model, /model <роль> <low|medium|high|xhigh|max>",
        text: "модель везде Opus 5.5, меняется только effort по ролям (raphael, day, clients, filter, writer; all — все сразу). По умолчанию low.",
        example: "/model writer high",
      },
    ],
  },
  {
    title: "Голос, фото, видео",
    items: [
      {
        kind: "info",
        usage: "🎤 Голосовое боту",
        text: "бот расшифрует и ответит как на текст. Работает и в /day — можно надиктовать день.",
      },
      {
        kind: "info",
        usage: "📷 Фото / скрин",
        text: "бот посмотрит картинку. Подпись — это вопрос к ней.",
        example: "скрин ошибки с подписью «почему падает?»",
      },
      {
        kind: "info",
        usage: "🎥 Видео / кружок",
        text: "бот смотрит несколько кадров и слушает звук. Файлы больше 20 МБ Telegram боту не отдаёт.",
      },
      {
        kind: "info",
        usage: "От клиентов",
        text: "голосовые, фото и видео клиентов тоже разбираются, но ответ на них всегда только черновиком.",
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
        usage: "/scan_clients [папка]",
        text: "проверить все чаты папки (по умолчанию «Клиенты»): кто ждёт ответа, кто отказал, у кого сменился статус. Изменения для CRM придут одной карточкой ✅.",
        example: "/scan_clients",
      },
      {
        kind: "command",
        usage: "/stop_queue",
        text: "остановить очередь сообщений, которую Джарвис запустил после твоего ✅ (пауза 40–90 с, не больше 25 в день).",
        example: "/stop_queue",
      },
      {
        kind: "command",
        usage: "/day",
        text: "начать разбор сегодняшнего дня — бот задаст несколько вопросов и сам соберёт посты для каналов.",
        example: "/day",
      },
      {
        kind: "command",
        usage: "/stop",
        text: "выйти из разбора дня (или сам выключится после 3 ч тишины).",
        example: "/stop",
      },
      {
        kind: "info",
        usage: "Загрузить старую переписку",
        text: "бот видит только сообщения после подключения. Старые: Telegram Desktop → чат → ⋮ → Экспорт истории → JSON → отправь result.json боту.",
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
