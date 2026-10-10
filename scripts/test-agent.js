// Офлайн-тесты агента (без Telegram и без Claude): парсеры, фильтры постов,
// метрики каналов, расписание, стратегии, модели.
// Живой тест стриминга Джарвиса (дёргает claude -p на haiku): node scripts/test-agent.js --live
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.BOT_TOKEN ||= "test-token";
process.env.OWNER_TELEGRAM_ID ||= "111";
process.env.DRY_RUN = "true";
const tmpState = path.join(os.tmpdir(), `agent-test-state-${Date.now()}.json`);
process.env.STATE_PATH = tmpState;
process.env.UNTRA_DATA_DIR = path.join(os.tmpdir(), `agent-test-untra-${Date.now()}`);

const { parseFilter, parseWriter, postPassesHeuristics, channelMetrics, channelQualifies, scoreChannel, isCancelText, dictatedText, bansFromInstruction, banViolations } = await import("../src/comments.js");
const { redditPostPasses } = await import("../src/reddit.js");
const { tashkentNow, shouldFire, currentTasks, taskDueToday, isQuietTime, reminderAllowed, TASK_RUNNER_KEYS, nextContraFormat, CONTRA_POST_FORMATS } = await import("../src/planner.js");
const J = await import("../src/jarvis.js");
const { watcherDue, parseClassification } = await import("../src/watcher.js");
const TASKS = currentTasks();
const { strategiesFor, readStrategy, addStrategyNote, removeStrategyNote, strategiesBlock } = await import("../src/strategies.js");
const { getModel, getEffort, setEffort, resetEfforts } = await import("../src/models.js");
const { visibleRaphaelText, parseChatRequest } = await import("../src/raphael.js");
const { localRoute } = await import("../src/team.js");

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
  if (!cond) failed += 1;
}

// Фильтр / писатель
check("filter yes", parseFilter("yes: про продажи в телеграм").ok === true);
check("filter no", parseFilter("no: политика").ok === false);
check("filter да", parseFilter("да — про клиентов").ok === true);
check("filter мусор -> no", parseFilter("не знаю").ok === false);
check("writer SKIP", parseWriter("SKIP") === null);
check("writer кавычки", parseWriter("«Короткий коммент по делу»") === "Короткий коммент по делу");
check("writer префикс", parseWriter("Комментарий: текст") === "текст");

// Эвристики постов
const now = Date.now();
const good = { text: "x".repeat(120) + " как вы принимаете заказы в телеграм?", date: now - 30 * 60_000, hasComments: true };
check("пост ок", postPassesHeuristics(good, now).ok);
// Отмена и буквальные правки
for (const t of ["Бро отмен", "отмена", "ОТМЕНИ ОТПРАВКУ", "стоп", "не отправляй", "бро, отмени"]) check(`отмена: ${t}`, isCancelText(t));
for (const t of ["сделай короче", "стопроцентно норм", "убери легенду", "отменный пост, похвали"]) check(`не отмена: ${t}`, !isCancelText(t));
check("диктовка в кавычках", dictatedText('просто напиши "гуд айдия бро, попробую тоже"') === "гуд айдия бро, попробую тоже");
check("диктовка «»", dictatedText("скажи: «имба, попробую»") === "имба, попробую");
check("не диктовка", dictatedText("просто похвали его") === null);
const b1 = bansFromInstruction("без слова легенда и не упоминай свои проекты");
check("бан слова", b1.words.includes("легенда") && b1.noProjects);
check("бан ловит форму", banViolations("ты просто легенду сделал", b1).includes("легенда"));
check("бан проекты", banViolations("я в Noor делал так же", b1).length === 1);
check("чистый текст", banViolations("гуд айдия бро, попробую тоже", b1).length === 0);
check("стоп-слова не баним", bansFromInstruction("без воды и без длинных тире").words.length === 0);
check("пост старый", !postPassesHeuristics({ ...good, date: now - 5 * 3_600_000 }, now).ok);
check("пост короткий", !postPassesHeuristics({ ...good, text: "коротко" }, now).ok);
check("пост без комментов", !postPassesHeuristics({ ...good, hasComments: false }, now).ok);
check("пост реклама", !postPassesHeuristics({ ...good, text: good.text + " #реклама erid: 123" }, now).ok);

// Метрики каналов
const day = 86_400_000;
const posts = Array.from({ length: 10 }, (_, i) => ({ date: now - i * day, replies: 4 }));
const m = channelMetrics(posts, now);
check("perWeek ~5", m.perWeek === 5);
check("avgReplies 4", m.avgReplies === 4);
check("канал подходит", channelQualifies({ linkedChatId: "1", ...m, participants: 5000 }));
check("без комментов не подходит", !channelQualifies({ linkedChatId: null, ...m, participants: 5000 }));
check("огромный не подходит", !channelQualifies({ linkedChatId: "1", ...m, participants: 500000 }));
check("score > 0", scoreChannel({ ...m, participants: 5000 }) > 0);

// Reddit
const rp = { title: "How do I cache fetch in Next.js app router?", selftext: "I tried revalidate but it doesn't work as I expect in production", created_utc: now / 1000 - 3600, num_comments: 2 };
check("reddit вопрос ок", redditPostPasses(rp, now));
check("reddit старый", !redditPostPasses({ ...rp, created_utc: now / 1000 - 3 * 86400 }, now));
check("reddit много ответов", !redditPostPasses({ ...rp, num_comments: 40 }, now));
check("reddit не вопрос", !redditPostPasses({ ...rp, title: "My new portfolio site", selftext: "Built with love and coffee, check it out friends" }, now));

// Планировщик
const toMinTest = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const tn = tashkentNow(new Date("2026-09-29T08:10:00Z")); // Вт 13:10 в Ташкенте
check("ташкент время", tn.time === "13:10" && tn.dow === 2 && tn.date === "2026-09-29");
const tg = TASKS.find((t) => t.key === "tg_post");
check("tg_post срабатывает во вторник 13:10", shouldFire(tg, tn, {}, new Date("2026-09-29T08:10:00Z")));
check("tg_post не дважды", !shouldFire(tg, tn, { "tg_post:2026-09-29": 1 }, new Date("2026-09-29T08:10:00Z")));
const mon = tashkentNow(new Date("2026-09-28T08:10:00Z"));
check("tg_post не в понедельник", !shouldFire(tg, mon, {}, new Date("2026-09-28T08:10:00Z")));
const late = tashkentNow(new Date("2026-09-29T17:30:00Z")); // 22:30
check("окно 3 ч прошло", !shouldFire(tg, late, {}, new Date("2026-09-29T17:30:00Z")));
check("тихие часы 23:45", isQuietTime({ time: "23:45" }) && isQuietTime({ time: "03:00" }) && !isQuietTime({ time: "11:30" }));
check("формат Contra по кругу", nextContraFormat(null).key === CONTRA_POST_FORMATS[0].key && nextContraFormat(CONTRA_POST_FORMATS.at(-1).key).key === CONTRA_POST_FORMATS[0].key && nextContraFormat("figma_to_code").key !== "figma_to_code");
check("комменты Contra в 11:30", TASKS.find((t) => t.key === "contra_comments").time === "11:30");
check("showoff отключён", !TASKS.some((t) => t.key === "showoff"));
check("воскресенье: только calm", TASKS.filter((t) => t.days.includes(0)).every((t) => t.type === "calm"));
check("суббота: только английский и calm", TASKS.filter((t) => t.days.includes(6)).every((t) => ["english_rem", "calm_1", "calm_2"].includes(t.key)));
check("работа не позже 21:00", TASKS.filter((t) => t.work).every((t) => toMinTest(t.time) + (t.window ?? 180) <= 21 * 60 + 15));
check("weekly в понедельник 11:05", TASKS.find((t) => t.key === "weekly").days.join() === "1" && TASKS.find((t) => t.key === "weekly").time === "11:05");

// Стратегии
check("contra по ключевому слову", strategiesFor("сколько постов на контре?").includes("contra"));
check("overview всегда", strategiesFor("привет").includes("overview"));
check("файл стратегии читается", readStrategy("linkedin").includes("кринж") || readStrategy("linkedin").includes("Кринж"));
addStrategyNote("contra", "теперь 4 поста в неделю");
check("правка видна", readStrategy("contra").includes("теперь 4 поста в неделю"));
check("правка удаляется", removeStrategyNote("contra", 0) && !readStrategy("contra").includes("теперь 4 поста"));
check("блок стратегий не пустой", strategiesBlock(["overview", "schedule"]).length > 500);

// Модели
check("модель везде opus 5.5", getModel("filter") === "claude-opus-5-5" && getModel("raphael") === "claude-opus-5-5");
check("effort по умолчанию: filter low, raphael/writer medium", getEffort("filter") === "low" && getEffort("raphael") === "medium" && getEffort("writer") === "medium");
setEffort("writer", "high");
check("effort writer high", getEffort("writer") === "high" && getEffort("filter") === "low");
check("кривой effort не ставится", setEffort("writer", "ultra") === false);
resetEfforts();
check("reset effort", getEffort("writer") === "medium");

// Стрим Джарвиса: служебные строки скрыты
check("стрим скрывает [[CHAT", visibleRaphaelText("[[CHAT: Бахтиёр]]") === null);
check("стрим чистит хвост", visibleRaphaelText("Ок, сейчас\n[[STRATEGY_NOTE: contra | 4 поста]]") === "Ок, сейчас");
check("стрим недописанный маркер", visibleRaphaelText("Текст [[CHA") === "Текст");
check("стрим маркер с одной ]", visibleRaphaelText("Принято.\n\n[[STRATEGY_NOTE: clients | без «с радостью»]") === "Принято.");
check("стрим прячет REWRITE", visibleRaphaelText("Сейчас переделаю\n[[REWRITE: 41 | короче]]") === "Сейчас переделаю");

// Локальный роутер (без Claude)
const pc1 = parseChatRequest("Ильяс | с 01.09.2026");
check("CHAT с датой", pc1.name === "Ильяс" && pc1.sinceTs === new Date("2026-09-01T00:00:00+05:00").getTime());
check("CHAT с ДД.ММ без года", parseChatRequest("x | 01.09").sinceTs > 0);
check("CHAT ISO", parseChatRequest("x | 2026-09-01").sinceTs === pc1.sinceTs);
check("CHAT число", parseChatRequest("@bob | 500").limit === 500 && parseChatRequest("@bob | 500").sinceTs === 0);
check("CHAT весь чат", parseChatRequest("ада | всё").sinceTs === 1 && parseChatRequest("ада | полностью").sinceTs === 1);
check("CHAT по умолчанию 120", parseChatRequest("Bob").limit === 120);
check("роутер: выключи автоответы", localRoute("выключи автоответы")?.action === "auto_off");
check("роутер: включи комменты", localRoute("включи комментарии")?.action === "comments_on");
check("роутер: закрой задачу 3", localRoute("закрой задачу 3")?.arg === "3");
check("роутер: добавь @канал", localRoute("добавь @durov_channel")?.action === "watch_add");
check("роутер: память", localRoute("что помнишь?")?.action === "memory_list");
check("стоп автоответы — не отмена коммента", !isCancelText("стоп автоответы"));
check("роутер: план", localRoute("план на сегодня")?.action === "plan");
check("роутер: найди каналы", localRoute("найди ещё каналов")?.action === "watch_find");
check("роутер: напомни", localRoute("напомни через 2 часа написать Алине")?.arg === "2h написать Алине");
check("роутер: напомни мин", localRoute("напомни через 30 минут выпить воды")?.arg === "30m выпить воды");
check("роутер: запомни", localRoute("запомни: созвон в пятницу")?.arg === "созвон в пятницу");
check("роутер: задачи", localRoute("мои задачи")?.action === "todo_list");
check("роутер: сложное -> Джарвис", localRoute("найди мне клиентов и напиши им") === null);
check("роутер: вопрос про каналы -> Джарвис", localRoute("почему так мало каналов?") === null);


// --- outreach: скан, CRM_BATCH, SEND_QUEUE ---
{
  const { classifyChat, STATUS, extractJsonMarkers, stripJsonMarkers, workdaysSince, crmEventFor, isRefusalText } = await import("../src/outreach.js");
  const { crmLog, loadCrm } = await import("../src/untra/store.js");
  const t0 = Date.parse("2026-10-05T10:00:00+05:00");
  const out = { id: 10, out: true, date: t0, text: "Здравствуйте" };
  const inc = (id, text, dt = 3600e3) => ({ id, out: false, date: t0 + dt, text });
  check("скан: отказ", classifyChat({ msgs: [inc(11, "Спасибо, нет, нам не нужно"), out], lastOut: out }) === STATUS.refusal);
  check("скан: «спасибо» не отказ", !isRefusalText("Спасибо, посмотрю"));
  check("скан: узб. отказ", classifyChat({ msgs: [inc(11, "hozircha kerak emas"), out], lastOut: out }) === STATUS.refusal);
  check("скан: автоответ быстрый", classifyChat({ msgs: [inc(11, "Здравствуйте!", 3000), out], lastOut: out }) === STATUS.auto);
  check("скан: автоответ бот", classifyChat({ isBot: true, msgs: [inc(11, "Меню"), out], lastOut: out }) === STATUS.auto);
  check("скан: ждёт ответа", classifyChat({ msgs: [inc(11, "А сколько стоит?"), out], lastOut: out }) === STATUS.waiting);
  check("скан: не отправлено", classifyChat({ msgs: [], lastOut: null }) === STATUS.notSent);
  check("скан: написал первым → ждёт ответа", classifyChat({ msgs: [inc(11, "Привет")], lastOut: null }) === STATUS.waiting);
  check("скан: не просмотрено", classifyChat({ msgs: [out], lastOut: out, readOutboxMaxId: 9 }) === STATUS.unread);
  check("скан: просмотрено", classifyChat({ msgs: [out], lastOut: out, readOutboxMaxId: 10 }) === STATUS.seen);
  const now = Date.parse("2026-10-08T12:00:00+05:00"); // чт
  check("раб. дни пн→чт = 3", workdaysSince("2026-10-05", now) === 3);
  check("раб. дни пт→пн = 1", workdaysSince("2026-10-02", Date.parse("2026-10-05T12:00:00+05:00")) === 1);
  check("скан: холодный", classifyChat({ msgs: [out], lastOut: out, readOutboxMaxId: 10, lead: { status: "Напоминание отправлено", last_contact: "2026-10-05" }, now }) === STATUS.cold);
  check("скан: напоминание свежее", classifyChat({ msgs: [out], lastOut: out, readOutboxMaxId: 10, lead: { status: "Напоминание отправлено", last_contact: "2026-10-07" }, now }) === STATUS.seen);

  const txt = 'Ок, вот очередь.\n[[SEND_QUEUE: [{"to":"@shop","text":"Текст ]] с [скобками]","crm":{"action":"reminder","id":"C-001"}}] ]]\n[[CRM_BATCH: [{"action":"note","id":"C-2","status":"Отказ"}]]]';
  const q = extractJsonMarkers(txt, "SEND_QUEUE");
  check("SEND_QUEUE разобран", q.length === 1 && q[0].value?.[0]?.text === "Текст ]] с [скобками]");
  check("CRM_BATCH разобран", extractJsonMarkers(txt, "CRM_BATCH")[0]?.value?.[0]?.id === "C-2");
  check("маркеры скрыты", stripJsonMarkers(txt).trim() === "Ок, вот очередь.");
  check("скан скрыт в стриме", visibleRaphaelText("[[SCAN_CLIENTS]]") === null && visibleRaphaelText("Проверяю.\n[[SCAN_CLIENTS: Клиенты]]") === "Проверяю.");
  check("недописанный SEND_QUEUE скрыт", visibleRaphaelText('Готово.\n[[SEND_QUEUE: [{"to":"@a"') === "Готово.");

  // Фикс: отказ от того, кого нет в CRM
  let lead = null;
  try {
    lead = crmLog({ action: "refusal", contact: "@nobody_shop", business: "Nobody", summary: "Отказ: не нужно" }, "test");
  } catch {}
  check("refusal без лида создаёт лида", lead?.status === "Отказ" && lead?.note === "не из рассылки" && lead?.do_not_write === true);
  const before = loadCrm().daily.length;
  const ev = crmEventFor({ id: "555", username: "newshop", title: "New Shop" }, STATUS.seen, null);
  crmLog(ev, "test");
  const created = loadCrm().leads.find((l) => l.handle === "@newshop");
  check("новый чат из скана: статус и без daily", created?.status === STATUS.seen && loadCrm().daily.length === before);
  crmLog({ action: "note", id: created.id, status: STATUS.waiting }, "test");
  check("note со статусом меняет статус", loadCrm().leads.find((l) => l.id === created.id)?.status === STATUS.waiting);
}

if (process.argv.includes("--live")) {
  const { askRaphael } = await import("../src/claudeClient.js");
  
  let deltas = 0;
  const started = Date.now();
  let firstAt = null;
  const res = await askRaphael({
    prompt: "Напиши 3 коротких предложения о том, зачем фронтендеру Contra.",
    systemText: "Отвечай по-русски, коротко.",
    onDelta: () => {
      deltas += 1;
      firstAt ||= Date.now();
    },
  });
  console.log(`\n[live] первый кусок через ${((firstAt - started) / 1000).toFixed(1)} с, всего ${((Date.now() - started) / 1000).toFixed(1)} с, кусков ${deltas}\n${res.text}\n`);
  check("live: стрим пришёл кусками", deltas >= 1 && res.text.length > 20);
}


// --- Настройки Джарвиса (state/jarvis.json), временный UNTRA_DATA_DIR ---
const seed = J.loadJarvis();
const OLD_KEYS = ["brief", "tg_post", "contra_post", "linkedin_post", "linkedin_comments", "contra_comments", "contra_foryou_1", "contra_foryou_2", "contra_foryou_3", "contra_foryou_4", "contra_foryou_5", "discovery_report", "weekly", "evening_plan", "school_rem", "physics_rem", "math_rem", "english_rem", "calm_1", "calm_2"];
check("seed: файл создан", fs.existsSync(path.join(process.env.UNTRA_DATA_DIR, "untra", "state", "jarvis.json")));
check("seed: все старые ключи задач", OLD_KEYS.every((k) => seed.reminders.some((r) => r.id === k)));
check("seed: обращение Мастер, без ошибок", seed.address === "Мастер" && J.validateJarvis(seed).length === 0);
check("seed: расписание из schedule.md", seed.schedule.find((s) => s.id === "math").from === "17:00" && seed.schedule.find((s) => s.id === "english").days.join() === "2,4,6");
check("seed: типы и поля", seed.reminders.find((r) => r.id === "brief").type === "task" && seed.reminders.find((r) => r.id === "contra_foryou_5").window === 15 && seed.reminders.find((r) => r.id === "linkedin_post").evenWeeks === true && seed.reminders.find((r) => r.id === "calm_1").type === "calm" && seed.reminders.find((r) => r.id === "school_rem").work === false);
check("seed: task-ключи есть в планировщике", seed.reminders.filter((r) => r.type === "task").every((r) => TASK_RUNNER_KEYS.includes(r.task)) && [...J.TASK_KEYS].sort().join() === [...TASK_RUNNER_KEYS].sort().join());
const tn2 = (iso) => tashkentNow(new Date(iso));
const find = (id) => currentTasks().find((t) => t.key === id);
const sat = tn2("2026-10-10T09:00:00Z"); // Сб 14:00
const sun = tn2("2026-10-11T07:30:00Z"); // Вс 12:30
check("правила: работа молчит в субботу", !reminderAllowed(find("contra_comments"), sat) && !shouldFire({ ...find("contra_comments"), days: [6], time: "14:00" }, sat, {}, new Date("2026-10-10T09:00:00Z")));
check("правила: работа молчит в воскресенье", !reminderAllowed(find("brief"), sun));
check("правила: английский в субботу можно", reminderAllowed(find("english_rem"), sat));
check("правила: calm в воскресенье срабатывает", shouldFire(find("calm_1"), sun, {}, new Date("2026-10-11T07:30:00Z")));
const eve = tn2("2026-10-08T16:05:00Z"); // Чт 21:05
check("правила: работа молчит после 21:00", !reminderAllowed(find("contra_foryou_5"), eve) && reminderAllowed(find("contra_foryou_5"), tn2("2026-10-08T15:45:00Z")));
check("правила: нерабочее после 21:00 можно", reminderAllowed(find("calm_2"), eve));
check("правила: тихие часы блокируют всё", !reminderAllowed(find("calm_1"), { ...sun, time: "23:40" }) && !reminderAllowed(find("calm_1"), { ...sun, time: "07:00" }));

let r = J.applyJarvisOps({ op: "set", path: "rules.noWorkAfter", value: "20:00" });
check("ops set: noWorkAfter", r.ok && J.loadJarvis().rules.noWorkAfter === "20:00" && /noWorkAfter/.test(r.summary));
check("правила следуют за файлом", !reminderAllowed(find("contra_foryou_5"), tn2("2026-10-08T15:15:00Z")));
r = J.applyJarvisOps([{ op: "set", path: "rules.dayOffWork", value: [] }, { op: "set", path: "address", value: "Азиз" }]);
check("ops set: массив операций", r.ok && J.loadJarvis().rules.dayOffWork.length === 0 && J.loadJarvis().address === "Азиз");
r = J.applyJarvisOps({ op: "add", list: "reminders", value: { days: [0, 1], time: "15:00", type: "text", text: "Выпей воды." } });
const added = J.loadJarvis().reminders.find((x) => x.text === "Выпей воды.");
check("ops add: id сгенерирован, work=false, window", r.ok && added && added.id.startsWith("r_") && added.work === false && added.enabled === true && added.window === 30);
r = J.applyJarvisOps({ op: "update", list: "reminders", id: added.id, value: { time: "16:30", enabled: false } });
check("ops update", r.ok && J.loadJarvis().reminders.find((x) => x.id === added.id).time === "16:30" && !currentTasks().some((t) => t.key === added.id));
r = J.applyJarvisOps({ op: "remove", list: "reminders", id: added.id });
check("ops remove", r.ok && !J.loadJarvis().reminders.some((x) => x.id === added.id));
r = J.applyJarvisOps([{ op: "add", list: "watch.chats", value: { query: "Ильяс" } }, { op: "add", list: "style", value: "без эмодзи" }, { op: "add", list: "tasks", value: { text: "Сдать отчёт", important: true, due: "2026-10-12" } }]);
check("ops add: чат, стиль, задача", r.ok && J.loadJarvis().watch.chats[0].query === "Ильяс" && J.loadJarvis().style.includes("без эмодзи") && J.loadJarvis().tasks[0].important === true);
r = J.applyJarvisOps({ op: "remove", list: "style", value: 2 });
check("ops remove style по номеру", r.ok && !J.loadJarvis().style.includes("без эмодзи"));
r = J.applyJarvisOps({ op: "remove", list: "watch.chats", id: "ильяс" });
check("ops remove чат", r.ok && J.loadJarvis().watch.chats.length === 0);
const before = JSON.stringify(J.loadJarvis());
const bad = [
  [{ op: "set", path: "watch.intervalMin", value: 2 }, /5–1440/],
  [{ op: "set", path: "rules.quietHours", value: "25:00-08:00" }, /ЧЧ:ММ/],
  [{ op: "set", path: "version", value: 2 }, /менять нельзя/],
  [{ op: "add", list: "reminders", value: { id: "x1", days: [7], time: "10:00", type: "text", text: "a" } }, /days/],
  [{ op: "add", list: "reminders", value: { id: "x1", days: [1], time: "10:61", type: "text", text: "a" } }, /time/],
  [{ op: "add", list: "reminders", value: { id: "x1", days: [1], time: "10:00", type: "task", task: "nope" } }, /неизвестный task/],
  [{ op: "add", list: "reminders", value: { id: "x1", days: [1], time: "10:00", type: "robot" } }, /type/],
  [{ op: "update", list: "reminders", id: "нет", value: {} }, /нет записи/],
  [{ op: "remove", list: "reminders", id: "нет" }, /не нашёл/],
  [{ op: "fly" }, /неизвестная операция/],
  [{ op: "add", list: "nope", value: 1 }, /не существует/],
];
for (const [op, re] of bad) {
  const x = J.applyJarvisOps(op);
  check(`ops ошибка: ${JSON.stringify(op).slice(0, 55)}`, !x.ok && re.test(x.errors.join(" ")));
}
r = J.applyJarvisOps([{ op: "set", path: "address", value: "Бро" }, { op: "set", path: "watch.intervalMin", value: 1 }]);
check("ops: при ошибке ничего не сохраняется", !r.ok && JSON.stringify(J.loadJarvis()) === before && fs.readFileSync(path.join(process.env.UNTRA_DATA_DIR, "untra", "state", "jarvis.json"), "utf-8").includes('"Азиз"'));
const prompt = J.jarvisPromptText();
check("промпт: обращение, правила, чаты", prompt.includes("«Азиз»") && prompt.includes("state/jarvis.json") && prompt.includes("brief") && prompt.includes("тихие часы 23:30-08:00"));

// Маркер [[JARVIS_SET]]
const m1 = '[[JARVIS_SET: {"op":"set","path":"address","value":"Брат ]] тест"}]]';
const mm = J.extractJarvisSet(`Готово.\n${m1}\nЕщё текст`);
check("маркер: объект с ]] в строке", mm.length === 1 && mm[0].value.value === "Брат ]] тест");
const m2 = '[[JARVIS_SET: [{"op":"add","list":"style","value":"a"},{"op":"remove","list":"style","value":"a"}] ]]';
check("маркер: массив", J.extractJarvisSet(m2)[0].value.length === 2);
check("маркер: битый JSON -> null", J.extractJarvisSet("[[JARVIS_SET: {oops} ]]")[0].value === null);
check("маркер вырезан", J.stripJarvisSet(`До ${m1} после`).replace(/\s+/g, " ") === "До после");
check("маркер вырезан в стриме", visibleRaphaelText('Делаю. [[JARVIS_SET: {"op":"set","pa') === "Делаю." && visibleRaphaelText(`Ок ${m2}`) === "Ок");

// Наблюдатель
const wj = { rules: { quietHours: "23:30-08:00" }, watch: { chats: [{ query: "a" }], from: "08:00", to: "21:00", intervalMin: 30 } };
const t0 = 1_000_000_000_000;
check("watcher: в окне и прошло 30 мин", watcherDue(wj, { time: "12:00" }, t0 - 31 * 60_000, t0));
check("watcher: рано (интервал)", !watcherDue(wj, { time: "12:00" }, t0 - 10 * 60_000, t0));
check("watcher: вне окна / тихие часы", !watcherDue(wj, { time: "21:30" }, 0, t0) && !watcherDue(wj, { time: "06:00" }, 0, t0));
check("watcher: нет чатов", !watcherDue({ ...wj, watch: { ...wj.watch, chats: [] } }, { time: "12:00" }, 0, t0));
check("watcher: разбор ответа", parseClassification('{"important":true,"summary":" Просят счёт. "}').summary === "Просят счёт." && parseClassification("мусор") === null && parseClassification('{"important":"yes"}').important === false);

fs.rmSync(tmpState, { force: true });
fs.rmSync(process.env.UNTRA_DATA_DIR, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAIL` : "\nВсё ок");
process.exit(failed ? 1 : 0);
