#!/usr/bin/env python3
"""Разовый перенос CRM из telegram_clients_crm.xlsx в data/crm.json для сервера.
Запуск: python3 scripts/import-crm.py <путь к xlsx> <куда положить crm.json>
Excel не меняется. Архивные листы (Новые лиды, Барберы) не переносятся — они в бэкапе."""
import datetime as dt, json, sys
import openpyxl

COLS = {"ID": "id", "Бизнес": "business", "Контакт / чат": "contact", "Ссылка": "link", "Handle": "handle",
        "Оффер": "offer", "Первый контакт": "first_contact", "Последний контакт": "last_contact", "Статус": "status",
        "Приоритет": "priority", "Этап": "stage", "Последний ответ / сигнал": "last_signal", "Краткий итог": "summary",
        "Почему зависло": "stuck", "Стратегия": "strategy", "Следующее сообщение": "next_message",
        "Следующий шаг": "next_step", "Дата шага": "next_date", "Не писать?": "do_not_write",
        "Примечание": "note", "Источник": "source", "Сегмент": "segment", "Рынок": "market", "Канал": "channel"}
DAILY = {"Дата": "date", "Сегмент": "segment", "Рынок": "market", "Канал": "channel", "Лид": "lead",
         "Статус": "status", "Ответ": "reply", "CRM ID": "crm_id", "Тип": "type"}

def val(v):
    if isinstance(v, (dt.datetime, dt.date)): return v.isoformat()[:10] if isinstance(v, dt.date) and not isinstance(v, dt.datetime) or v.hour == 0 and v.minute == 0 else v.isoformat(sep=" ")[:16]
    return v.strip() if isinstance(v, str) else v

def table(ws, mapping=None):
    rows = list(ws.iter_rows(values_only=True))
    h = next(i for i, r in enumerate(rows[:10]) if sum(1 for c in r if c) >= 3)
    hdr = [str(c).strip() if c else "" for c in rows[h]]
    out = []
    for r in rows[h + 1:]:
        if not any(r): continue
        d = {}
        for name, v in zip(hdr, r):
            if not name or v in (None, ""): continue
            key = mapping.get(name) if mapping else name
            if key: d[key] = val(v)
        if d: out.append(d)
    return out

wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
leads = [l for l in table(wb["CRM"], COLS) if str(l.get("id", "")).startswith("C-")]
for l in leads:
    l["do_not_write"] = str(l.get("do_not_write", "")).strip().lower() in ("да", "yes", "true", "1")
crm = {"imported_at": dt.datetime.now().isoformat(timespec="minutes"), "leads": leads,
       "stoplist": table(wb["Не писать"]), "daily": table(wb["Daily outreach"], DAILY)}
json.dump(crm, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"лидов {len(leads)}, стоп-лист {len(crm['stoplist'])}, строк Daily outreach {len(crm['daily'])}")
