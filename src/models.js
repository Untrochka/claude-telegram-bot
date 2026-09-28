// Какая модель Claude работает в какой роли. Дефолты — из .env (config),
// поверх — выбор владельца через /model, хранится в state.json и переживает
// деплой. На подписке доступность opus зависит от тарифа.
import { config } from "./config.js";
import { getAgentValue, setAgentValue } from "./state.js";

export const MODEL_CHOICES = ["haiku", "sonnet", "opus"];

export const ROLES = {
  raphael: "Рафаэль (личный чат)",
  day: "/day — разбор дня",
  clients: "Автоответчик клиентам",
  filter: "Фильтр постов (подходит ли для коммента)",
  writer: "Писатель комментариев и адаптаций постов",
};

function defaults() {
  return {
    raphael: config.claudeModelSmart,
    day: config.claudeModelSmart,
    clients: config.claudeModelFast,
    filter: config.claudeModelFilter,
    writer: config.claudeModelSmart,
  };
}

export function getModel(role) {
  const overrides = getAgentValue("models", {});
  return overrides[role] || defaults()[role] || config.claudeModelSmart;
}

export function setModel(role, model) {
  if (!ROLES[role] || !MODEL_CHOICES.includes(model)) return false;
  const overrides = { ...getAgentValue("models", {}) };
  overrides[role] = model;
  setAgentValue("models", overrides);
  return true;
}

export function resetModels() {
  setAgentValue("models", {});
}

export function modelsText() {
  const overrides = getAgentValue("models", {});
  const lines = Object.entries(ROLES).map(([role, label]) => {
    const mark = overrides[role] ? "" : " (по умолчанию)";
    return `• ${role} — ${getModel(role)}${mark}\n   ${label}`;
  });
  return [
    "Модели по ролям:",
    ...lines,
    "",
    "Сменить: /model <роль> <haiku|sonnet|opus>",
    "Например: /model raphael opus",
    "Все по умолчанию: /model reset",
    "haiku — самый быстрый, sonnet — баланс, opus — самый умный (если есть в подписке).",
  ].join("\n");
}
