# Laya Engine — локальный сервис типизированных решений на Go

Автономный движок инференса модели [Laya](https://huggingface.co/convaiinnovations/laya)
(мультиязычная System 1, ~322M параметров, ModernBERT + голова типизированных
решений). Отвечает на типизированные вопросы о тексте — `choice`, `score`, `noul` —
за один forward pass, без генерации текста.

**Python в рантайме не нужен.** Токенизатор и вся сборка входа реализованы на Go,
инференс идёт через ONNX Runtime (C API, cgo). Python использовался только как
эталон при разработке (сверка ответов) и в рантайме не участвует.

Сервис один на всю машину: Киборг, Deepseec и любые будущие задачи (торговые
стратегии, обработка данных) ходят в него по loopback, а не поднимают свои копии
весов.

## Что уже работает

| Проверка | Результат |
|---|---|
| Токенизатор на Go против HF tokenizers | совпадение на всех 32 контрольных строках |
| Сквозной ответ против Python-эталона (200 кейсов, 1200 ответов) | расхождений нет |
| Латентность на RTX 3060 (6 вопросов на запрос) | p50 ≈ 46–56 мс, p95 ≈ 77 мс |
| Устройство | `cuda`, GPU по умолчанию #0 (на тестовой машине — RTX 3060) |

## Быстрый старт

```cmd
build.cmd          :: gofmt + vet + test + сборка bin\laya-server.exe
start-laya.cmd     :: запуск на GPU #0, loopback 127.0.0.1:8095; /gpu N — выбрать карту
stop-laya.cmd      :: остановка
```

Проверка установки без запуска сервиса:

```cmd
bin\laya-server.exe -device cuda -device-id 0 -model models\multilingual-fp16.onnx -ort bin\onnxruntime.dll -selftest
```

## Требования

* **Go 1.26+**, **gcc** (cgo). На этой машине gcc из MSYS2:
  `C:\msys64\ucrt64\bin\gcc.exe` (ставится `pacman -S mingw-w64-ucrt-x86_64-gcc`).
* **onnxruntime.dll** от **1.25.0** — ровно эта версия, потому что Go-обвязка
  собрана под C API v25 (`ORT_API_VERSION 25`). Лежит в `bin\`.
  Нужна **GPU-сборка** (`onnxruntime-win-x64-gpu-1.25.0.zip`): в ней есть
  `onnxruntime_providers_cuda.dll`.
* **CUDA 12 + cuDNN 9** — провайдер CUDA статически тянет `cudart64_12.dll`,
  `cublas64_12.dll`, `cublasLt64_12.dll`, `cudnn64_9.dll`, `cufft64_11.dll`.
  Системный CUDA Toolkit v13.3 этих имён не содержит, поэтому нужные версии
  лежат в `third_party\cuda12\` (можно взять из пакетов `nvidia-*-cu12`).
  Каталог подмешивается в PATH самим движком до инициализации ORT.

## Модель

```
models\multilingual-fp16.onnx   617 МБ   рабочая (fp16, 322M)
models\tokenizer.json            33 МБ   словарь mmBERT, 256000 токенов
```

`models\multilingual-int8.onnx` (873 МБ) **не использовать**: у этого экспорта
квантование уничтожило голову решений — логиты вариантов почти совпадают, а
`act_logits` выходят за 1000. Симптом: у всех вопросов уверенность ≈ 1/k
(равномерное распределение), на эталонном примере из документации Laya модель
отвечает случайным вариантом. Причина известна: голова (`scorer`, `act_head`),
LayerNorm и эмбеддинги квантованию не подлежат — в PR к llama.cpp их специально
оставляют в F16/F32. Если понадобится INT8, квантовать нужно только matmul
энкодера, с явным исключением головы.

Скачивание модели:

```cmd
curl -L -o models\multilingual-fp16.onnx https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/model.onnx
curl -L -o models\tokenizer.json https://huggingface.co/techtheist/laya-onnx/resolve/main/multilingual/tokenizer.json
```

Параметры чекпоинта (`rl_agent_config.json`): `max_len=1024`, `head_max_len=256`,
энкодер `jhu-clsp/mmBERT-base`, температура 1.0 для всех типов вопросов.

## HTTP API

Слушает только `127.0.0.1` (по умолчанию порт 8095).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | процесс жив (модель может ещё грузиться) |
| GET | `/ready` | модель загружена и готова отвечать |
| GET | `/info` | версия схемы, устройство, модель, **чекпоинт**, счётчики |
| POST | `/decide` | ответы на батч вопросов по одному состоянию |
| POST | `/count` | бюджеты состояния и вопросов **без инференса** (токенизация, ~1 мс) |
| POST | `/benchmark` | замер p50/p95/p99 и пропускной способности |
| GET | `/v1/models` | Jev-совместимый список модели (id, чекпоинт, лимиты) |
| POST | `/v1/systemone` | Jev-совместимая форма ответа (та же логика, что `/decide`) |

### Чекпоинт

`/info` и каждый ответ `/decide` несут идентификатор загруженных весов:

```json
"checkpoint": {
  "file": "multilingual-fp16.onnx",
  "bytes": 646870871,
  "sha256": "0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c",
  "source": "manifest"
}
```

Сумма берётся из `models\model-manifest.json`, если размер файла совпадает
(`source: manifest`), иначе считается по файлу (`source: runtime`). Короткий id
для логов и метрик — `multilingual-fp16-0b095e005a4c`. Клиенты обязаны привязывать
пороги и замеры к этому идентификатору: подмена весов без смены id невозможна.

### POST /decide

```json
{
  "state": "удали файл D:\\tmp\\old.txt и покажи список",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Какой набор инструментов нужен?",
      "criteria": {
        "dialog": "просто ответить словами",
        "files_write": "изменить или удалить файл на диске",
        "console": "выполнить команду в терминале"
      }
    },
    "mutates": {
      "type": "noul",
      "instructions": "Изменяет ли запрос состояние?"
    }
  },
  "max_len": 1024
}
```

Ответ:

```json
{
  "version": 1,
  "model": "laya-go",
  "checkpoint": "multilingual-fp16-0b095e005a4c",
  "answers": {
    "route": {
      "type": "choice", "choice": "files_write",
      "probabilities": [{"label": "dialog", "value": 0.01}, …],
      "confidence": 0.61, "answer_confidence": 0.98, "act_probability": 1,
      "temperature": 1, "state_dropped": 0
    },
    "mutates": {"type": "noul", "noul": 0.93, …}
  },
  "order": ["route", "mutates"],
  "usage": {"input_tokens": 104, "output_tokens": 0},
  "budget": {
    "state_tokens": 104,
    "state_dropped_max": 0,
    "state_truncated": false,
    "max_len": 1024
  },
  "elapsed_ms": 59.06
}
```

Порядок вероятностей совпадает с порядком вариантов в запросе. Порядок `answers`
в объекте JSON не гарантирован — для сопоставления используйте `order`.
`max_len` (64..8192) — необязательное переопределение бюджета на один запрос.

**Об обрезке состояния.** Состояние режется **справа** под бюджет `max_len`;
у разных вопросов разное число вариантов, поэтому и свободного места под state
разное. Если `budget.state_truncated = true` или `state_dropped > 0` в ответе —
модель не видела хвост текста, и «уверенный» ответ может быть уверенным именно
поэтому. Решающие факты кладите в НАЧАЛО состояния. Поле `head_truncated`
означает, что не поместилась инструкция вопроса, `collapsed` — что варианты
после обрезки стали неразличимы (ответ недостоверен).

**О `confidence` и `answer_confidence`.** Порог ставить нужно по
`answer_confidence` (= `max(p)`): именно эту величину калибрует температурное
масштабирование. `confidence` — нормированная энтропия, она не калибрована и
сравнивать её с тем же порогом нельзя.

**О `act_probability`.** Это softmax от `act_logits`. У этой модели значения
насыщены (почти всегда 1.0), потому что `act_logits` выходят за ±1000. Как
совещательный сигнал она бесполезна — не полагайтесь на неё.

### POST /count

Тот же вход, что у `/decide`, но ответ — только бюджеты, без вызова модели
(удобно, чтобы укоротить состояние ДО инференса):

```json
{
  "state_tokens": 37, "max_len": 1024, "head_max_len": 256, "fits": true,
  "questions": [{
    "options": 2, "options_distinct": 2, "collapsed": false,
    "head_tokens": 17, "head_truncated": false, "option_tokens": 16,
    "state_kept": 37, "state_dropped": 0, "seq_len": 76, "fits": true
  }],
  "elapsed_ms": 1.24
}
```

### Jev-совместимый фасад

`GET /v1/models` отдаёт id `laya-go` и метаданные (чекпоинт, device, лимиты,
типы вопросов). `POST /v1/systemone` принимает `{model, state, questions}` и
отвечает в той же форме, что `/decide`. Неизвестная модель → `404 unknown_model`.
Родной контракт — `/decide`: он полнее (порядок, бюджет, телеметрия на вопрос).

### POST /benchmark

```json
{"state": "разбери BTC по Герчику", "questions": {…}, "iterations": 30, "concurrency": 1}
```

## Интеграция с ZCode

Плагин `davinci-laya-decisions` (каталог `..\plugin\` этого репозитория) использует этот
сервис в точках контроля ZCode: гейт риска на PreToolUse (по умолчанию shadow —
считает и логирует, разрешения не меняет), ledger изменений, проверка
доказательств на Stop, ранжирование контекста и 13 MCP-инструментов
(`laya_decide`, `laya_classify`, `laya_score`, `laya_batch`, `laya_search`,
`laya_read_relevant`, `laya_run_check`, `laya_search_relevant`, `laya_log_triage`,
`laya_context_pick`, `laya_get_chunk`, `laya_rank_diff`, `laya_health`). Клиенты обязаны обрабатывать `budget.state_truncated` и
`collapsed`: ответ по обрезанному состоянию не должен влиять на решения.

Измерения интеграции на этой машине (чекпоинт `multilingual-fp16-0b095e005a4c`):
детерминированные правила риска FNR=0/35, FPR=0/21; Laya в одиночку ставит `high`
только 7/35 опасным и 0/21 безопасным; латентность 3 вопросов p50≈35 мс,
p95≈49 мс. Вывод: правила отвечают за полноту, модель — за осторожность без
ложных тревог. Подробности — `..\plugin\docs`.

## Флаги и переменные окружения

| Флаг | Переменная | По умолчанию | Смысл |
|---|---|---|---|
| `-addr` | `LAYA_ADDR` | `127.0.0.1:8095` | адрес прослушивания |
| `-model` | `LAYA_MODEL` | `models\multilingual-fp16.onnx` | веса |
| `-tokenizer` | `LAYA_TOKENIZER` | `models\tokenizer.json` | словарь |
| `-ort` | `LAYA_ORT` | рядом с exe | путь к `onnxruntime.dll` |
| `-device` | `LAYA_DEVICE` | `cuda` | `cuda` или `cpu` |
| `-device-id` | `LAYA_DEVICE_ID` | `0` | номер GPU; выберите подходящую карту через `/gpu N` |
| `-max-len` | `LAYA_MAX_LEN` | `1024` | бюджет последовательности |
| `-head-len` | `LAYA_HEAD_MAX_LEN` | `256` | бюджет блока вопросов |
| `-threads` | `LAYA_THREADS` | `0` | потоки ONNX на CPU |
| `-allow-cpu-fallback` | `LAYA_CPU_FALLBACK` | `false` | разрешить откат на CPU при сбое CUDA |
| `-warmup` | `LAYA_WARMUP` | `true` | прогрев видеокарты после загрузки |
| — | `LAYA_CUDA_DLL_DIRS` | — | каталоги CUDA 12/cuDNN 9 через `;` |

Откат на CPU **по умолчанию запрещён намеренно**: молчаливый откат уже приводил
к тому, что замеры «на видеокарте» на самом деле шли на процессоре. Если CUDA не
поднимается, сервис падает с внятной ошибкой, а не деградирует незаметно.

## Как это устроено

```
cmd\laya-server\main.go     точка входа, флаги, прогрев
server\server.go            HTTP API, бенчмарк
engine\model.go             ONNX-сессия (CUDA/CPU), батч, декодирование
engine\sequence.go          сборка [CLS] вопрос [SEP] [MASK]варианты… [SEP] состояние [SEP]
engine\question.go          разбор вопросов, рендер вариантов (порядок ключей сохраняется)
engine\cudaenv.go           поиск и подключение библиотек CUDA 12/cuDNN 9
tokenizer\tokenizer.go      mmBERT: Replace(" "→"▁") + Metaspace + BPE(byte_fallback)
tools\*.py                  инструменты разработки: эталоны и диагностика
```

Препроцессинг повторяет эталон один в один: нормализация пробелов в `▁`,
претокенайзер Metaspace с `prepend_scheme=always`, BPE с byte_fallback, позиции
маркеров на токенах `<mask>` каждого варианта. Любое расхождение здесь не даёт
ошибки — оно молча меняет ответ, поэтому и зафиксировано тестом против эталона.

## Тесты

```cmd
go test ./...                          :: быстрые тесты
go test ./tokenizer/ -v                :: сверка токенизатора с HF (32 кейса)
set LAYA_HEAVY=1 && set LAYA_DEVICE_ID=0 && go test ./engine/ -run Reference -v
                                       :: тяжёлая сверка с Python-эталоном (200 кейсов)
```

Инструменты разработки (Python-эталоны) в этот дистрибутив не входят. В
`tools\` оставлены только скрипты установки и проверки:

```cmd
powershell -ExecutionPolicy Bypass -File tools\fetch-model.ps1
powershell -ExecutionPolicy Bypass -File tools\verify-model.ps1
powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1
```

## Если что-то не так

| Симптом | Причина и что делать |
|---|---|
| `CUDA недоступна ... cublasLt64_12.dll missing` | нет библиотек CUDA 12. Проверьте `third_party\cuda12\` или задайте `LAYA_CUDA_DLL_DIRS` |
| `Allocator ... failed` / OOM | карта занята. Проверьте `nvidia-smi`, при необходимости снизьте `-max-len` |
| Первый вызов ~500 мс, дальше 50 мс | не отработал прогрев (`-warmup`); при долгом простое повторится |
| У всех вопросов уверенность ≈ 1/k | взята испорченная INT8-модель — см. раздел «Модель» |
| `unsupported_schema` | версия API сервиса и клиента разошлись |
| Сервис отвечает, но `/ready` не готов | веса ещё грузятся (5–10 с) |

## Лицензии

Laya — Apache-2.0 (commercial use). ONNX Runtime — MIT. Код движка входит в этот репозиторий и распространяется по MIT
(см. корневой LICENSE).
