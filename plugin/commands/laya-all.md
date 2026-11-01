---
description: Laya-first (/laya-all) — self-fetching инструменты для широкого поиска, больших файлов и проверок
---

# Режим экономии контекста Laya

Аргумент: `on` | `off`; без аргумента — `on`. Неизвестное значение отклоняется
до записи. Режим **не меняет разрешения пользователя**: `riskGate.mode`,
`doneGate.mode` и `activeModes` остаются прежними. Он включает:
`router=log` (класс задачи — только в метрики), `sessionContext=on` (одна строка
статуса на старте) и `layaAll=true` (низкие пороги отбора).

```bash
PLUGIN_ROOT="${ZCODE_PLUGIN_ROOT:-$(node -e 'try{const fs=require("fs"),path=require("path"),os=require("os");const f=path.join(os.homedir(),".zcode","cli","plugins","installed_plugins.json");const j=JSON.parse(fs.readFileSync(f,"utf8"));const p=(j.plugins||[]).find(x=>x.name==="davinci-laya-decisions");if(!p)process.exit(2);process.stdout.write(p.installPath)}catch(e){process.exit(2)}')}"
test -f "$PLUGIN_ROOT/scripts/laya-admin.mjs" || { printf 'Не найден laya-admin.mjs: %s\n' "$PLUGIN_ROOT" >&2; exit 2; }
node "$PLUGIN_ROOT/scripts/laya-admin.mjs" status
node "$PLUGIN_ROOT/scripts/laya-admin.mjs" all "on"   # или off
node "$PLUGIN_ROOT/scripts/laya-admin.mjs" status
```

## Как работать в режиме

**Нет обязательного `laya_*` вызова на ход.** Вызывай инструмент, когда он
заменяет чтение, а не когда нужна галочка.

| Ситуация | Действие |
|---|---|
| Поиск по проекту, попаданий много | `laya_search(query, root, budget)` — сам ищет, дедуплицирует и ранжирует |
| Нужен фрагмент большого файла | `laya_read_relevant(path, query, budget)` — блоки с контекстом и отметками пропусков |
| Нужен факт проверки | `laya_run_check(check_id, budget)` — exit code, ошибки, полный вывод в chunk |
| Большой лог уже получен | `laya_log_triage` — уникальные ошибки с «×N» и file:line |
| Несколько решений | один `laya_decide`/`laya_batch`, не N вызовов |
| Diff >3 ханков | `laya_rank_diff` — только порядок внимания, **не review** |
| Маленький файл/точная выборка | читать напрямую; Laya не нужна |

Правила:
- сначала бесплатный поиск/`laya_search`, затем Laya по коротким кандидатам;
- выдержка — не источник: перед правкой дочитай `chunk_id` или `Read`;
- требования пользователя, актуальные ошибки и доказательства проверок
  сохраняются (pinned); архив доступен через `laya_get_chunk`;
- провал проверки и таймаут не скрываются и не пересказываются как успех;
- маркеры `state_dropped`/`head_truncated`/`collapsed` означают неполный ответ
  Laya — сократи state или упрости вопрос;
- при сомнении верь фактам (`git`, exit code, тесты), не вероятности.

В финале — короткий отчёт только если инструменты реально применялись: что
заменили, сколько текста не попало в контекст, какие ограничения остались.
Не вызывай Laya ради отчёта.

`/laya-all off` возвращает наблюдение: `shadow/report/log`, `sessionContext=off`,
`layaAll=false`.
