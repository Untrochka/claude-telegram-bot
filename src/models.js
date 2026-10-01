// Модель у бота одна — Opus 5.5 (решение Азиза). По ролям меняется только
// effort (сколько модель думает): по умолчанию low, Рафаэль и писатель — medium; поверх — выбор
// владельца через /model, хранится в state.json и переживает деплой.
import { config } from "./config.js";
import { getAgentValue, setAgentValue } from "./state.js";

export const MODEL = config.claudeModel;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const ROLES = {
  raphael: "Рафаэль (личный чат)",
  day: "/day — разбор дня",
  clients: "Автоответчик клиентам",
  filter: "Фильтр постов (подходит ли для коммента)",
  writer: "Писатель комментариев и адаптаций постов",
  reader: "Сжатие длинных переписок для Рафаэля",
};

export function getModel() {
  return MODEL;
}

// Там, где важно внимательно слушать Мастера (Рафаэль, правки комментов), —
// medium: чуть дороже за вызов, но меньше переделок. Остальное — low.
const ROLE_DEFAULTS = { raphael: "medium", writer: "medium" };

export function defaultEffort(role) {
  return process.env.BOT_CLAUDE_EFFORT ? config.claudeEffort : ROLE_DEFAULTS[role] || config.claudeEffort;
}

export function getEffort(role) {
  const overrides = getAgentValue("effort", {});
  return overrides[role] || defaultEffort(role);
}

export function setEffort(role, effort) {
  if (!ROLES[role] || !EFFORTS.includes(effort)) return false;
  setAgentValue("effort", { ...getAgentValue("effort", {}), [role]: effort });
  return true;
}

export function resetEfforts() {
  setAgentValue("effort", {});
}

export function modelsText() {
  const overrides = getAgentValue("effort", {});
  const lines = Object.entries(ROLES).map(([role, label]) => {
    const mark = overrides[role] ? "" : " (по умолчанию)";
    return `• ${role} — ${getEffort(role)}${mark}\n   ${label}`;
  });
  return [
    `Модель везде: ${MODEL}`,
    "Effort по ролям:",
    ...lines,
    "",
    `Сменить: /model <роль> <${EFFORTS.join("|")}>`,
    "Например: /model writer high",
    "Везде сразу: /model all medium · По умолчанию: /model reset (Рафаэль и писатель — medium, остальные — low)",
    "low — быстро и дёшево, high/xhigh — думает дольше и аккуратнее, max — максимум (медленно).",
  ].join("\n");
}
