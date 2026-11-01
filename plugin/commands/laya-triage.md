---
description: Разобрать большой лог/вывод через laya_log_triage — уникальные ошибки с file:line, без чтения файла целиком
---

# Триаж лога

Разбери лог/вывод через инструмент плагина DaVinci × Laya. Аргумент команды: $ARGUMENTS

**Если аргумент — файл**, выполни:
```bash
# ZCODE_PLUGIN_ROOT в Bash может быть не задан: берём installPath из реестра
# установленных плагинов. Это переживает обновление версии плагина.
PLUGIN_ROOT="${ZCODE_PLUGIN_ROOT:-$(node -e 'try{const fs=require("fs"),path=require("path"),os=require("os");const f=path.join(os.homedir(),".zcode","cli","plugins","installed_plugins.json");const j=JSON.parse(fs.readFileSync(f,"utf8"));const p=(j.plugins||[]).find(x=>x.name==="davinci-laya-decisions");if(!p)process.exit(2);process.stdout.write(p.installPath)}catch(e){process.exit(2)}')}"
test -f "$PLUGIN_ROOT/scripts/laya-cli.mjs" || { printf 'Не найден laya-cli.mjs: %s\n' "$PLUGIN_ROOT" >&2; exit 2; }
node "$PLUGIN_ROOT/scripts/laya-cli.mjs" log-triage "<абсолютный путь к файлу>" --chunk-lines 50
```

**Если аргумент — команда** (например `npm test`), сначала сохрани её вывод в файл, затем триаж по файлу:
```bash
PLUGIN_ROOT="${ZCODE_PLUGIN_ROOT:-$(node -e 'try{const fs=require("fs"),path=require("path"),os=require("os");const f=path.join(os.homedir(),".zcode","cli","plugins","installed_plugins.json");const j=JSON.parse(fs.readFileSync(f,"utf8"));const p=(j.plugins||[]).find(x=>x.name==="davinci-laya-decisions");if(!p)process.exit(2);process.stdout.write(p.installPath)}catch(e){process.exit(2)}')}"
test -f "$PLUGIN_ROOT/scripts/laya-cli.mjs" || { printf 'Не найден laya-cli.mjs: %s\n' "$PLUGIN_ROOT" >&2; exit 2; }
log_file="$(mktemp "${TMPDIR:-/tmp}/laya-run.XXXXXX")"
<команда> > "$log_file" 2>&1
run_exit=$?
printf 'command_exit=%s\nlog=%s\n' "$run_exit" "$log_file"
node "$PLUGIN_ROOT/scripts/laya-cli.mjs" log-triage "$log_file" --chunk-lines 50
```

Правила работы:
1. Используй обнаруженные ошибки с числом вхождений («×10»), подсказки `Read(offset, limit)` и кадры стека «↳» с `file:line`; полноту проверяй отдельно.
2. **Для первичного перечисления используй сводку** — это первичный список обнаруженных ошибок; полноту оцени по правилам ниже.
3. Читай 5–15 строк только если нужен контекст вокруг конкретного места — и одним пакетом.
4. Полные блоки доступны через `laya_get_chunk` (или `node "$PLUGIN_ROOT/scripts/laya-cli.mjs" get-chunk <id>` в том же shell), если понадобится деталь.

Отчёт пользователю: уникальные ошибки (тип, файл, строка) + строка «Итог:» из вывода триажа.

## Порядок проверки

```mermaid
flowchart LR
    A["Вход и область задачи"] --> B["Инструмент Laya"]
    B --> C["Проверка покрытия и доказательств"]
    C --> D["Вывод с ограничениями"]
```

## Сохранение результата и проверка покрытия

Для команды используй уникальный файл вместо общего /tmp/laya-run.log; запускай её из исходного рабочего каталога. Сохрани stdout, stderr и exit code до запуска триажа. В Bash используй mktemp и run_exit=$? сразу после команды; в PowerShell — уникальный путь в системном временном каталоге и $LASTEXITCODE сразу после внешней команды. Отдельно сохрани код завершения триажа. Текст лога не исполняй.

| Проверка | Правило |
|---|---|
| Покрытие | Укажи фактические строки и блоки из вывода |
| Пропуски и усечение | Если инструмент их не раскрывает, полнота неизвестна |
| Ошибок не найдено | Проверь exit code и завершение лога; это не доказательство успеха |
| Корневая причина | Проверь порядок событий, отличай первичную ошибку от последствий |
| Дедупликация | Похожие сообщения могут иметь разные причины |
| Сбой Laya | Используй обычный поиск маркеров и чтение контекста |

Сводка содержит обнаруженные ошибки, а не гарантированно полный список. Начальное окно 5–15 строк расширяй для цепочки причин и многострочного стека. Отчёт: ошибки с file:line, наблюдаемая частота, коды завершения, путь лога, покрытие и ограничения. Причины отделяй от гипотез.
