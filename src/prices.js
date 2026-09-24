// Единственный источник разрешённых цен (в сумах). Персона (src/persona.md)
// должна называть только эти цифры — эта проверка страхует от того, что
// модель придумает/перепутает число в свободном тексте (intent: price).
//
// Значения соответствуют прайсу из persona.md:
// 2 500 000 — Catalog Pilot / барбер-одиночка
// 3 000 000 — Каталог Start
// 4 500 000 — Каталог Sync
// 6 500 000 — Продажи
// 9 200 000 — Полный магазин (от)
// 1 500 000 — доп. модуль корзина+заказ / CRM (от) / Click-Payme (от) / промо для первых 3 барберов
// 2 000 000 — курьерский сервис (от)
export const ALLOWED_PRICES = [1_500_000, 2_000_000, 2_500_000, 3_000_000, 4_500_000, 6_500_000, 9_200_000];

const ALLOWED_SET = new Set(ALLOWED_PRICES);

// "3.5 млн", "2,5 млн" -> 3 500 000 / 2 500 000
function extractMillions(text) {
  const amounts = [];
  const regex = /(\d+(?:[.,]\d+)?)\s*млн/gi;
  let match;
  while ((match = regex.exec(text))) {
    const num = parseFloat(match[1].replace(",", "."));
    if (!Number.isNaN(num)) amounts.push(Math.round(num * 1_000_000));
  }
  return amounts;
}

// "2 500 000 сум", "2.500.000 сум", "2500000 сум" -> 2 500 000
function extractSumAmounts(text) {
  const amounts = [];
  const regex = /(\d[\d .,]{2,})\s*сум/gi;
  let match;
  while ((match = regex.exec(text))) {
    const digitsOnly = match[1].replace(/\D/g, "");
    if (digitsOnly) amounts.push(Number(digitsOnly));
  }
  return amounts;
}

// Достаёт все упомянутые в тексте суммы денег (в сумах). "млн" считаем
// первым и вырезаем из текста, чтобы "2.5 млн сум" не задвоился в проверке "сум".
export function extractAmounts(text) {
  const millions = extractMillions(text);
  const withoutMillions = text.replace(/\d+(?:[.,]\d+)?\s*млн/gi, " ");
  const sums = extractSumAmounts(withoutMillions);
  return [...millions, ...sums];
}

// Проверяет, что все суммы в тексте входят в разрешённый прайс.
// Используется перед автоотправкой intent: price.
export function checkPrices(text) {
  const amounts = extractAmounts(text);
  const invalid = amounts.filter((a) => !ALLOWED_SET.has(a));
  return { ok: invalid.length === 0, amounts, invalid };
}
