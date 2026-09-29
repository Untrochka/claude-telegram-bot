// Модель у бота одна — Opus 5.5 (решение Азиза). По ролям меняется только
// effort (сколько модель думает): по умолчанию low везде, поверх — выбор
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
};

export function getModel() {
  return MODEL;
}

export function getEffort(role) {
  const overrides = getAgentValue("effort", {});
  return overrides[role] || config.claudeEffort;
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
    "Везде сразу: /model all medium · Вернуть low везде: /model reset",
    "low — быстро и дёшево, high/xhigh — думает дольше и аккуратнее, max — максимум (медленно).",
  ].join("\n");
}
