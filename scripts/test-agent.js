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
const { config } = await import("../src/config.js");
const L = await import("../src/llm.js");
const S = await import("../src/study.js");
const { listOpenTasks } = await import("../src/state.js");

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
check("суббота: только английский и calm", TASKS.filter((t) => t.days.includes(6)).every((t) => ["english_rem", "calm_1", "calm_2", "study_checkin"].includes(t.key)));
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


// --- Дешёвый LLM: Groq -> второй Groq -> Claude (без сети: подмена fetch и Claude) ---
L.setCheapLLM(null);
config.groqApiKey = "test-key";
const hdr = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const okBody = (txt) => ({ choices: [{ message: { content: txt } }] });
let fetchCalls = [];
const mkFetch = (plan) => async (url, init) => {
  const model = JSON.parse(init.body).model;
  fetchCalls.push(model);
  const r = plan[model] || { status: 200, body: okBody('{"ok":true}') };
  return { status: r.status, ok: r.status < 400, headers: hdr(r.headers || {}), json: async () => r.body ?? {} };
};
let claudeCalls = 0;
const claudeFake = async () => {
  claudeCalls += 1;
  return '```json\n{"from":"claude"}\n```';
};
check("llm: разбор длительностей", L.parseDurationSec("2m59.56s") > 179.5 && L.parseDurationSec("7.66s") === 7.66 && L.parseDurationSec("30") === 30 && L.parseDurationSec("120ms") === 0.12 && L.parseDurationSec("") === null);
check("llm: JSON из ```", L.parseJsonLoose('текст ```json\n{"a":1}\n```').a === 1 && L.parseJsonLoose("не json") === null);
L.resetLLMState();
L.setLLMTransport({ fetch: mkFetch({}), claude: claudeFake });
let r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u", quality: "fast" });
check("llm: fast -> groq fast", r1.provider === `groq:${config.groqFastModel}` && r1.json.ok === true);
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u", quality: "smart" });
check("llm: smart -> groq smart", r1.provider === `groq:${config.groqSmartModel}`);
fetchCalls = [];
L.resetLLMState();
L.setLLMTransport({ fetch: mkFetch({ [config.groqSmartModel]: { status: 429, headers: { "retry-after": "30" } } }), claude: claudeFake });
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u", quality: "smart" });
check("llm: smart 429 -> fast", r1.provider === `groq:${config.groqFastModel}` && L.llmStats().cooling[config.groqSmartModel] > 0 && L.llmStats().cooling[config.groqSmartModel] <= 30);
fetchCalls = [];
await L.cheapLLM({ purpose: "t", system: "s", user: "u", quality: "smart" });
check("llm: модель на паузе не дёргается", !fetchCalls.includes(config.groqSmartModel));
L.resetLLMState();
claudeCalls = 0;
L.setLLMTransport({ fetch: mkFetch({ [config.groqFastModel]: { status: 429, headers: { "retry-after": "20" } }, [config.groqSmartModel]: { status: 429, headers: { "x-ratelimit-reset-requests": "1m0s" } } }), claude: claudeFake });
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u" });
check("llm: оба 429 -> Claude", r1.provider === "claude" && r1.json.from === "claude" && claudeCalls === 1 && Object.keys(L.llmStats().cooling).length === 2);
fetchCalls = [];
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u" });
check("llm: обе на паузе -> сразу Claude, без fetch", r1.provider === "claude" && fetchCalls.length === 0);
let threw = false;
try {
  await L.cheapLLM({ purpose: "t", system: "s", user: "u", fallback: "none" });
} catch {
  threw = true;
}
check("llm: fallback none бросает ошибку", threw);
L.resetLLMState();
L.setLLMTransport({ fetch: mkFetch({ [config.groqFastModel]: { status: 200, headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "12s" } } }), claude: claudeFake });
await L.cheapLLM({ purpose: "t", system: "s", user: "u" });
check("llm: остаток 0 -> пауза до сброса", L.llmStats().cooling[config.groqFastModel] > 0 && L.llmStats().limits[config.groqFastModel].remainingRequests === 0);
L.resetLLMState();
L.setLLMTransport({ fetch: mkFetch({ [config.groqFastModel]: { status: 200, body: okBody("не json") }, [config.groqSmartModel]: { status: 500, body: { error: { message: "boom" } } } }), claude: claudeFake });
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u" });
check("llm: мусор и 500 -> Claude; счётчики", r1.provider === "claude" && L.llmStats().requests.claude === 1 && L.llmStats().failures[`groq:${config.groqFastModel}`] === 1 && /Дешёвый LLM/.test(L.llmStatsText()));
L.resetLLMState();
config.groqApiKey = "";
L.setLLMTransport({ fetch: mkFetch({}), claude: claudeFake });
r1 = await L.cheapLLM({ purpose: "t", system: "s", user: "u" });
check("llm: нет ключа Groq -> Claude", r1.provider === "claude");
config.groqApiKey = "test-key";

// Наблюдатель через cheapLLM (подмена)
L.setCheapLLM(async () => ({ text: '{"important":true,"summary":"Просят счёт"}', json: {}, provider: "mock" }));
const { classifyMessages } = await import("../src/watcher.js");
const cl = await classifyMessages("Ильяс", [{ date: Date.now(), sender: "Ильяс", text: "вышли счёт" }], ["деньги"]);
check("watcher: classifyMessages через cheapLLM", cl.important === true && cl.summary === "Просят счёт");
L.setCheapLLM(async () => {
  throw new Error("всё недоступно");
});
check("watcher: сбой LLM -> null", (await classifyMessages("x", [{ date: Date.now(), sender: "a", text: "b" }], [])) === null);
L.setCheapLLM(null);

// --- Учёба: математика ---
const mk = (list) => ({ ...S.emptyStudy(), sessions: list.map(([subject, type, volume, minutes, extra], i) => ({ id: `s${i + 1}`, date: `2026-09-${String(i + 1).padStart(2, "0")}`, subject, type, volume, unit: "задач", minutes, flows: null, difficulty: "normal", newTopic: false, estimateMin: null, homeworkId: null, ...(extra || {}) })) });
check("study: медиана", S.median([2, 4, 3, 10]) === 3.5 && S.median([5, 1, 9]) === 5 && S.median([]) === null);
check("study: flow -> минуты", S.flowsToMinutes(6, 25) === 150 && S.flowsToMinutes(3, 30) === 90);
const s1 = mk([["physics", "problems", 70, 150]]);
let e = S.estimate("physics", "problems", 30, { study: s1 });
check("study: 1 точка = low, ±15%, буфер 30%", e.expectedMin === 64 && e.confidence === "low" && e.range.join() === "55,74" && e.safeMin === 84 && e.n === 1 && e.source === "type");
check("study: сложность при <3 точек", S.estimate("physics", "problems", 30, { study: s1, difficulty: "hard" }).expectedMin === 84 && S.estimate("physics", "problems", 30, { study: s1, difficulty: "easy" }).expectedMin === 57 && S.estimate("physics", "problems", 30, { study: s1, newTopic: true }).expectedMin === 77);
const s3 = mk([["physics", "problems", 10, 20], ["physics", "problems", 10, 30], ["physics", "problems", 10, 40]]);
e = S.estimate("physics", "problems", 10, { study: s3, difficulty: "hard", newTopic: true });
check("study: 3 точки = medium, сложность не применяется, буфер 20%", e.expectedMin === 30 && !e.adjusted && e.confidence === "medium" && e.range.join() === "27,33" && e.safeMin === 36);
const s6 = mk(Array.from({ length: 6 }, (_, i) => ["math", "problems", 10, 20 + i]));
e = S.estimate("math", "problems", 10, { study: s6 });
check("study: 6 точек = high, ±7%, буфер 15%", e.confidence === "high" && e.expectedMin === 23 && e.range.join() === "21,24" && e.buffer === 0.15 && S.bufferFor(11) === 0.1 && S.bufferFor(2) === 0.3 && S.bufferFor(5) === 0.2);
const s12 = mk([["math", "problems", 1, 100], ["math", "problems", 1, 100], ...Array.from({ length: 10 }, () => ["math", "problems", 1, 2])]);
check("study: медиана только по последним 10", S.estimate("math", "problems", 10, { study: s12 }).expectedMin === 20 && S.estimate("math", "problems", 10, { study: s12 }).n === 12 && S.estimate("math", "problems", 10, { study: s12 }).buffer === 0.1);
e = S.estimate("physics", "theory", 5, { study: s1 });
check("study: нет данных по типу -> медиана предмета, low", e.source === "subject" && e.confidence === "low" && e.expectedMin === 11);
check("study: нет данных вообще -> null", S.estimate("english", "reading", 5, { study: s1 }) === null && S.estimate("physics", "problems", null, { study: s1 }) === null);
const sNoVol = mk([["physics", "problems", null, 60], ["physics", "problems", 30, 60]]);
check("study: сессии без объёма не идут в скорость", S.baseline(sNoVol, "physics", "problems").n === 1 && S.estimate("physics", "problems", 30, { study: sNoVol }).expectedMin === 60);
const sRatio = mk([["math", "problems", 10, 150, { estimateMin: 100 }], ["math", "problems", 10, 100, { estimateMin: 100 }]]);
check("study: ошибка оценок и своя оценка владельца", Math.abs(S.errorRatio(sRatio).avg - 1.25) < 1e-9 && S.estimate("physics", "theory", 5, { study: sRatio, ownerEstimateMin: 60 }).expectedMin === 75 && S.estimate("physics", "theory", 5, { study: sRatio, ownerEstimateMin: 60 }).source === "owner");
const sFlow = S.emptyStudy();
sFlow.flowMin = 30;
const ses = S.addSessionTo(sFlow, { subject: "Физика", type: "задачи", volume: "70", flows: 6 });
check("study: сессия через flows, алиасы предмета/типа", ses.minutes === 180 && ses.subject === "physics" && ses.type === "problems" && ses.volume === 70 && ses.id === "s1");
let badSes = null;
try {
  S.addSessionTo(sFlow, { subject: "physics", volume: 5 });
} catch (err) {
  badSes = err;
}
check("study: сессия без времени — ошибка", badSes instanceof S.StudyError);
check("study: типы не изобретаются", S.normType("physics", "аудирование") === null && S.normType("english", "аудирование") === "listening" && S.normSubject("алгебра") === "math" && S.normSubject("кулинария") === null);

// Дубли ДЗ
const hwBase = S.emptyStudy();
const nowMs = Date.parse("2026-10-10T09:00:00+05:00");
const hw1 = S.addHomeworkTo(hwBase, { subject: "math", text: "Решить 30 задач из сборника, стр. 45", volume: 30, deadline: "2026-10-14", unit: "задач" }, { nowMs, plan: false });
check("study: ДЗ создано", hw1.id === "h1" && hw1.type === "problems" && hw1.status === "todo" && hw1.estMin === null);
check("study: дубль в течение 7 дней", S.findDuplicateHomework(hwBase, { subject: "math", text: "решить 30 задач из сборника стр 45" }, nowMs + 86_400_000)?.id === "h1");
check("study: другой предмет / другой текст / позже 7 дней — не дубль", !S.findDuplicateHomework(hwBase, { subject: "physics", text: hw1.text }, nowMs) && !S.findDuplicateHomework(hwBase, { subject: "math", text: "выучить теорему Виета" }, nowMs) && !S.findDuplicateHomework(hwBase, { subject: "math", text: hw1.text }, nowMs + 8 * 86_400_000));

// Слот под ДЗ: не на занятия, не в воскресенье, не поздно
const dj = J.defaultJarvis(); // Вт: английский 15:30–17:00; Ср: математика 17:00–20:20
check("слот: вечер перед сроком (Вт 19:00)", S.planSlot({ deadline: "2026-10-14", estMin: 60, nowMs, jarvis: dj }) === "2026-10-13T19:00");
check("слот: после математики, а не поверх (Ср 21:05)", S.planSlot({ deadline: "2026-10-15", estMin: 60, nowMs, jarvis: dj }) === "2026-10-14T21:05");
check("слот: длинное не лезет в окно после занятий -> день раньше", S.planSlot({ deadline: "2026-10-15", estMin: 120, nowMs, jarvis: dj }) === "2026-10-13T19:00");
check("слот: воскресенье пропускаем", S.planSlot({ deadline: "2026-10-12", estMin: 40, nowMs, jarvis: dj }) === "2026-10-10T19:00");
check("слот: без срока — ближайший свободный вечер", S.planSlot({ estMin: 30, nowMs, jarvis: dj }) === "2026-10-10T19:00");
check("слот: два ДЗ не накладываются", S.planSlot({ deadline: "2026-10-14", estMin: 40, nowMs, jarvis: dj, others: [{ planned: "2026-10-13T19:00", estMin: 50 }] }) === "2026-10-13T20:00");
check("слот: сегодня поздно и срок сегодня -> нет слота", S.planSlot({ deadline: "2026-10-10", estMin: 60, nowMs: Date.parse("2026-10-10T22:00:00+05:00"), jarvis: dj }) === null);
check("слот: не позже 22:30", (() => { const x = S.planSlot({ deadline: "2026-10-15", estMin: 60, nowMs, jarvis: dj }); return x && S.plannedToMs(x) + 60 * 60_000 <= Date.parse(`${x.slice(0, 10)}T22:30:00+05:00`); })());

// Миграция jarvis.json: study_checkin добавляется один раз
const jf = path.join(process.env.UNTRA_DATA_DIR, "untra", "state", "jarvis.json");
check("seed: study_checkin есть (пн–сб 20:30, не работа)", (() => { const r = J.loadJarvis().reminders.find((x) => x.id === "study_checkin"); return r && r.time === "20:30" && r.days.join() === "1,2,3,4,5,6" && r.work === false && r.task === "study_checkin"; })());
const old = JSON.parse(fs.readFileSync(jf, "utf-8"));
old.reminders = old.reminders.filter((x) => x.id !== "study_checkin");
delete old.migrated;
fs.writeFileSync(jf, JSON.stringify(old));
J.resetJarvisCache();
check("миграция: добавила study_checkin", J.loadJarvis().reminders.some((x) => x.id === "study_checkin") && JSON.parse(fs.readFileSync(jf, "utf-8")).migrated.includes("study_checkin"));
J.applyJarvisOps({ op: "remove", list: "reminders", id: "study_checkin" });
J.resetJarvisCache();
check("миграция: второй раз не возвращает удалённое", !J.loadJarvis().reminders.some((x) => x.id === "study_checkin"));
J.applyJarvisOps({ op: "add", list: "reminders", value: { id: "study_checkin", days: [1, 2, 3, 4, 5, 6], time: "20:30", type: "task", task: "study_checkin", work: false, hidden: true, window: 120 } });

// Чаты учёбы в jarvis.json
r = J.applyJarvisOps({ op: "add", list: "watch.chats", value: { query: "Математика 11", kind: "study", subject: "math" } });
check("watch.chats: kind study + subject", r.ok && J.loadJarvis().watch.chats.find((c) => c.query === "Математика 11").kind === "study" && J.jarvisPromptText().includes("[учёба:math]"));
check("watch.chats: плохой kind / subject отклоняются", !J.applyJarvisOps({ op: "add", list: "watch.chats", value: { query: "Z", kind: "robot" } }).ok && !J.applyJarvisOps({ op: "add", list: "watch.chats", value: { query: "Z", kind: "study", subject: "chemistry" } }).ok);
J.applyJarvisOps({ op: "remove", list: "watch.chats", id: "Математика 11" });

// Операции [[STUDY]] и валидация
r = S.applyStudyOps({ op: "add_homework", value: { subject: "physics", type: "problems", text: "Динамика, 30 задач", volume: 30, unit: "задач", deadline: "2099-01-05" } });
check("STUDY: add_homework + уведомление", r.ok && /добавил ДЗ h1/.test(r.summary) && r.notices.length === 1 && /Новое ДЗ \(Физика\)/.test(r.notices[0]) && S.loadStudy().homework.length === 1 && S.loadStudy().homework[0].planned);
check("STUDY: напоминание в planned создано (tasks)", listOpenTasks().some((t) => /Время ДЗ по физике/.test(t.text) && t.dueAt));
check("STUDY: дубль отклоняется", !S.applyStudyOps({ op: "add_homework", value: { subject: "physics", text: "динамика 30 задач", volume: 30 } }).ok);
const before2 = JSON.stringify(S.loadStudy());
r = S.applyStudyOps([{ op: "add_session", value: { subject: "math", type: "problems", volume: 10, minutes: 40 } }, { op: "add_session", value: { subject: "кулинария", minutes: 10 } }, { op: "remove", list: "homework", id: "h99" }, { op: "set", path: "flowMin", value: 3 }, { op: "fly" }]);
check("STUDY: ошибки не сохраняют ничего", !r.ok && r.errors.length === 4 && JSON.stringify(S.loadStudy()) === before2);
r = S.applyStudyOps([{ op: "done_homework", id: "h1", session: { flows: 4, difficulty: "easy" } }, { op: "set", path: "flowMin", value: 30 }]);
const st1 = S.loadStudy();
check("STUDY: done_homework + сессия (flows×flowMin по порядку)", r.ok && st1.homework[0].status === "done" && st1.homework[0].doneSessionId === "s1" && st1.sessions[0].minutes === 100 && st1.sessions[0].volume === 30 && st1.flowMin === 30);
r = S.applyStudyOps([{ op: "update_homework", id: "h1", value: { status: "todo", deadline: "2099-02-02" } }, { op: "add_session", value: { subject: "english", type: "vocabulary", minutes: 50, flows: 2 } }]);
check("STUDY: update_homework и add_session (minutes важнее flows)", r.ok && S.loadStudy().homework[0].deadline === "2099-02-02" && S.loadStudy().sessions[1].minutes === 50);
check("STUDY: update валидирует", !S.applyStudyOps({ op: "update_homework", id: "h1", value: { deadline: "завтра" } }).ok && !S.applyStudyOps({ op: "update_homework", id: "h1", value: { status: "zzz" } }).ok);
r = S.applyStudyOps([{ op: "remove", list: "sessions", id: "s2" }]);
check("STUDY: remove", r.ok && S.loadStudy().sessions.length === 1);
const sm = '[[STUDY: {"op":"set","path":"flowMin","value":25}]]';
check("STUDY: маркер извлекается и скрыт", J.extractTagged(`Ок ${sm} дальше`, "[[STUDY:")[0].value.value === 25 && visibleRaphaelText(`Ок ${sm}`) === "Ок" && visibleRaphaelText('Ок [[STUDY: {"op":"add_h') === "Ок");
check("STUDY: промпт Джарвиса", /Учёба и время/.test(S.studyPromptText()) && /Личные скорости/.test(S.studyPromptText()) && /physics\/problems/.test(S.studyPromptText()));

// Проверка ДЗ без Claude
const ck = S.emptyStudy();
check("check-in: пусто — молчим", S.checkinText(ck, nowMs) === null);
S.addHomeworkTo(ck, { subject: "physics", text: "30 задач", volume: 30, unit: "задач", deadline: "2026-10-20" }, { nowMs, plan: false });
check("check-in: срок далеко и слот не наступил — молчим", S.checkinText(ck, nowMs) === null);
ck.homework[0].planned = "2026-10-10T08:00";
check("check-in: слот прошёл — спрашиваем", S.checkinText(ck, nowMs) === 'Сделал ДЗ по физике (30 задач)? Напиши сколько и за сколько, например: "сделал 30, 3 flow".');
ck.homework[0].planned = null;
ck.homework[0].deadline = "2026-10-11";
check("check-in: срок завтра — спрашиваем", S.pendingForCheckin(ck, nowMs).length === 1);
ck.homework[0].status = "done";
check("check-in: выполненное не спрашиваем", S.checkinText(ck, nowMs) === null);

// Разбор чата учёбы и ДЗ из чата (подмена LLM)
let llmCalls = 0;
const hwDeadline = S.tnow(Date.now() + 3 * 86_400_000).date;
L.setCheapLLM(async (o) => {
  llmCalls += 1;
  if (o.purpose === "study_extract") {
    return { text: "", provider: "mock", json: { homework: [{ subject: "алгебра", type: "задачи", text: "Решить номера 12-40 из сборника", volume: 29, unit: "задач", deadline: hwDeadline }, { subject: "кулинария", text: "испечь пирог" }], other_important: true, summary: "Контрольная перенесена на пятницу" } };
  }
  return { text: "", provider: "mock", json: MOCK_INTENT };
});
let MOCK_INTENT = {};
const ex = await S.extractHomeworkFromChat("[10:00] Учитель: сделайте номера", { title: "Математика 11", subjectHint: "math" });
check("chat: extract возвращает ДЗ и важное", ex.homework.length === 2 && ex.other_important && /Контрольная/.test(ex.summary));
const ing = ex.homework.map((x) => S.ingestHomework(x, { source: "чат 'Математика 11'", subjectHint: "math" }));
check("chat: валидное ДЗ добавлено, мусорный предмет отклонён", ing[0].status === "added" && ing[0].hw.subject === "math" && ing[0].hw.source === "чат 'Математика 11'" && ing[1].status === "error");
check("chat: уведомление — формат, «оценки нет», слот", /^📚 Новое ДЗ \(Математика\): 29 задач/.test(ing[0].text) && /сдать до/.test(ing[0].text) && /Оценки пока нет/.test(ing[0].text) && /Поставил на/.test(ing[0].text));
check("chat: повтор не дублируется", S.ingestHomework(ex.homework[0], { subjectHint: "math" }).status === "duplicate");
const mathOpen = S.loadStudy().homework.find((h) => h.subject === "math");
check("chat: planned не пересекается с занятиями", (() => { const d = mathOpen.planned; if (!d) return false; const dow = new Date(`${d.slice(0, 10)}T00:00:00Z`).getUTCDay(); const m = Number(d.slice(11, 13)) * 60 + Number(d.slice(14)); return !J.loadJarvis().schedule.some((c) => c.days.includes(dow) && m >= J.toMin(c.from) && m < J.toMin(c.to)) && dow !== 0; })());

// Отчёты и вопросы владельца (классификатор подменён)
llmCalls = 0;
check("owner: без цифр/слов про учёбу классификатор не зовём", (await S.handleStudyMessage("как дела, расскажи анекдот")) === null && llmCalls === 0);
MOCK_INTENT = { intent: "study_report", confidence: 0.9, subject: "math", type: "problems", volume: 29, unit: "задач", minutes: null, flows: 3, difficulty: null, newTopic: null, estimateMin: null, homeworkRef: null };
let rep = await S.handleStudyMessage("сделал 29 по математике, 3 flow");
const stAfter = S.loadStudy();
check("owner: отчёт записан, ДЗ закрыто, формат ответа", rep.kind === "study_report" && /^Записал\.\nMath\/problems: 29 задач, 90 мин ≈3\.1 мин\/задачу ≈19\/час\.\nBaseline: ~3\.1 мин\/задачу\. Confidence: low — 1 datapoint\./.test(rep.reply.replace("Math/", "Math/")) && /ДЗ h\d+ закрыто/.test(rep.reply) && stAfter.homework.find((h) => h.subject === "math").status === "done");
MOCK_INTENT = { intent: "study_report", confidence: 0.9, subject: "physics", type: "problems", volume: 70, unit: "задач", minutes: 150, flows: null, difficulty: "hard", newTopic: false, estimateMin: 120 };
rep = await S.handleStudyMessage("физика 70 задач 150 минут, я думал на 2 часа");
check("owner: строка про ошибку оценки", /Оценка была 120 мин, по факту 150 \(×1\.25\)/.test(rep.reply) && /Physics\/problems: 70 задач, 150 мин ≈2\.14 мин\/задачу ≈28\/час\./.test(rep.reply));
MOCK_INTENT = { intent: "study_report", confidence: 0.9, subject: "physics", volume: 5, minutes: null, flows: null };
check("owner: отчёт без времени -> Claude", (await S.handleStudyMessage("физика 5 задач")) === null);
MOCK_INTENT = { intent: "study_report", confidence: 0.3, subject: "math", volume: 5, minutes: 20 };
check("owner: низкая уверенность -> Claude", (await S.handleStudyMessage("математика 5 задач 20 мин")) === null);
MOCK_INTENT = { intent: "other", confidence: 0.95 };
check("owner: other -> Claude", (await S.handleStudyMessage("перенеси встречу на 5 вечера")) === null);
MOCK_INTENT = { intent: "estimate_question", confidence: 0.9, items: [{ subject: "physics", type: "problems", volume: 30, unit: "задач" }, { subject: "english", type: "reading", volume: 3, unit: "страниц" }] };
rep = await S.handleStudyMessage("сколько займёт 30 задач по физике и 3 страницы reading", { nowMs });
check("owner: вопрос об оценке — ожидание, диапазон, безопасный срок, время окончания", rep.kind === "estimate_question" && /^Ожидаю: ~\d+ мин/.test(rep.reply) && /Физика\/problems, 30 задач: ~\d+ мин \(\d+–\d+\)/.test(rep.reply) && /Английский\/reading, 3 страниц: нет данных/.test(rep.reply) && /Безопасный срок: ~\d+ мин \(\+\d+%\)/.test(rep.reply) && /Если начать сейчас \(09:00\): закончу ~\d\d:\d\d, с запасом ~\d\d:\d\d/.test(rep.reply) && /Confidence:/.test(rep.reply));
L.setCheapLLM(async () => {
  throw new Error("нет LLM");
});
check("owner: классификатор упал -> null (обычный Джарвис)", (await S.handleStudyMessage("сделал 30 задач, 3 flow")) === null);
L.setCheapLLM(null);
L.setLLMTransport();

fs.rmSync(tmpState, { force: true });
fs.rmSync(process.env.UNTRA_DATA_DIR, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAIL` : "\nВсё ок");
process.exit(failed ? 1 : 0);
