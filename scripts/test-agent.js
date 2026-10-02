// Офлайн-тесты агента (без Telegram и без Claude): парсеры, фильтры постов,
// метрики каналов, расписание, стратегии, модели.
// Живой тест стриминга Рафаэля (дёргает claude -p на haiku): node scripts/test-agent.js --live
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.BOT_TOKEN ||= "test-token";
process.env.OWNER_TELEGRAM_ID ||= "111";
process.env.DRY_RUN = "true";
const tmpState = path.join(os.tmpdir(), `agent-test-state-${Date.now()}.json`);
process.env.STATE_PATH = tmpState;

const { parseFilter, parseWriter, postPassesHeuristics, channelMetrics, channelQualifies, scoreChannel, isCancelText, dictatedText, bansFromInstruction, banViolations } = await import("../src/comments.js");
const { redditPostPasses } = await import("../src/reddit.js");
const { tashkentNow, shouldFire, TASKS, taskDueToday } = await import("../src/planner.js");
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
const tn = tashkentNow(new Date("2026-09-29T08:10:00Z")); // Вт 13:10 в Ташкенте
check("ташкент время", tn.time === "13:10" && tn.dow === 2 && tn.date === "2026-09-29");
const tg = TASKS.find((t) => t.key === "tg_post");
check("tg_post срабатывает во вторник 13:10", shouldFire(tg, tn, {}, new Date("2026-09-29T08:10:00Z")));
check("tg_post не дважды", !shouldFire(tg, tn, { "tg_post:2026-09-29": 1 }, new Date("2026-09-29T08:10:00Z")));
const mon = tashkentNow(new Date("2026-09-28T08:10:00Z"));
check("tg_post не в понедельник", !shouldFire(tg, mon, {}, new Date("2026-09-28T08:10:00Z")));
const late = tashkentNow(new Date("2026-09-29T17:30:00Z")); // 22:30
check("окно 3 ч прошло", !shouldFire(tg, late, {}, new Date("2026-09-29T17:30:00Z")));
const show = TASKS.find((t) => t.key === "showoff");
check("showoff только первая суббота", taskDueToday(show, tashkentNow(new Date("2026-10-03T08:00:00Z"))) && !taskDueToday(show, tashkentNow(new Date("2026-10-10T08:00:00Z"))));

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

// Стрим Рафаэля: служебные строки скрыты
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
check("роутер: сложное -> Рафаэль", localRoute("найди мне клиентов и напиши им") === null);
check("роутер: вопрос про каналы -> Рафаэль", localRoute("почему так мало каналов?") === null);

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

fs.rmSync(tmpState, { force: true });
console.log(failed ? `\n${failed} FAIL` : "\nВсё ок");
process.exit(failed ? 1 : 0);
