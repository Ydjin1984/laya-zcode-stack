# Движок Laya: изменения и HTTP-контракт

Интеграция потребовала доработок локального движка (`<repo>\engine`).
Все изменения — обратносовместимые: прежние клиенты (`/health`, `/ready`, `/info`,
`/decide`, `/benchmark`) работают как раньше, добавлены поля и эндпоинты.

## Зачем меняли

1. **Молчаливая обрезка состояния.** Движок режет `state` справа под бюджет
   `max_len` и ничего об этом не сообщал. Клиент не мог отличить «модель прочитала
   весь текст» от «модель прочитала первые 500 токенов и уверенно ответила».
   Это главный источник ложного доверия к ответам.
2. **Чекпоинт не идентифицировался.** `/info` не говорил, какие именно веса
   загружены, — а пороги и калибровки привязаны к конкретным весам.
3. **Нельзя было измерить бюджет до инференса.** Клиент не мог заранее узнать,
   поместится ли состояние, и вынужден был узнавать об обрезке по факту.
4. **Jev-совместимого фасада не было.** Внешние инструменты (скрипты discovery,
   чужие обёртки) написаны под `GET /v1/models` + `POST /v1/systemone`.

## Что добавлено

### 1. Телеметрия обрезки в `/decide`

Новые поля ответа:

```json
{
  "budget": {
    "state_tokens": 812,          // полная длина состояния в токенах
    "state_dropped_max": 300,     // худшая потеря среди вопросов батча
    "state_truncated": true,      // хоть один вопрос потерял текст или варианты схлопнулись
    "max_len": 1024
  }
}
```

И в каждом ответе (`answers.<id>`):
- `state_dropped` — сколько токенов состояния не увидел именно этот вопрос
  (у разных вопросов разное число вариантов ⇒ разное место под state);
- `head_truncated` — инструкция вопроса не поместилась в `head_max_len`;
- `temperature` — фактический коэффициент калибровки логитов (без него
  `answer_confidence` невоспроизводима);
- `collapsed` (было и раньше) — варианты неразличимы после обрезки.

В `result`: `state_tokens`, `state_dropped_max`, `state_truncated`.

`/decide` теперь принимает `max_len` (64..8192) как переопределение бюджета на
один запрос.

### 2. Идентификация чекпоинта

```
GET /info → checkpoint: {
  "file": "multilingual-fp16.onnx",
  "bytes": 646870871,
  "sha256": "0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c",
  "source": "manifest"        // manifest | runtime | pending
}
```

Сумма берётся из `models\model-manifest.json` при совпадении размера файла (мгновенно);
при отсутствии манифеста — считается по файлу. Короткий id для логов:
`multilingual-fp16-0b095e005a4c`. Это же значение приходит в `checkpoint` у
`/decide` и `/v1/systemone`.

### 3. `POST /count` — бюджет без инференса

Токенизирует состояние и вопросы, но не трогает видеокарту (~1 мс):

```json
// запрос: {"state": "...", "questions": {...}, "max_len": 1024}
{
  "state_tokens": 37,
  "max_len": 1024, "head_max_len": 256,
  "fits": true,
  "questions": [{
    "options": 2, "options_distinct": 2, "collapsed": false,
    "head_tokens": 17, "head_truncated": false,
    "option_tokens": 16,
    "state_kept": 37, "state_dropped": 0,
    "seq_len": 76, "fits": true
  }]
}
```

Клиент использует это, чтобы **укоротить state до инференса**, а не узнавать
об обрезке постфактум.

### 4. Jev-совместимый фасад

- `GET /v1/models` — id модели и метаданные: `checkpoint`,
  `checkpoint_sha256`, `device`, `max_len`, `question_types`, указатели на
  родные эндпоинты.
- `POST /v1/systemone` — тело `{model, state, questions}` (та же форма, что
  `/decide`; `criteria` для `choice` — объект `{метка: описание}`, для `score` —
  массив уровней). Ответ совпадает с `/decide`, включая `checkpoint` и `budget`.
  Неизвестная модель → `404 unknown_model`.

Родной контракт остаётся `/decide`: он полнее (порядок вопросов, бюджет,
телеметрия на вопрос).

## Полный контракт

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | процесс жив: `{ok, uptime_s}` |
| GET | `/ready` | веса загружены: `{ready}` (503 пока нет) |
| GET | `/info` | версия схемы, device, модель, **checkpoint**, счётчики |
| POST | `/decide` | батч вопросов по одному состоянию (родной контракт) |
| POST | `/count` | бюджеты без инференса |
| POST | `/benchmark` | p50/p95/p99, rps |
| GET | `/v1/models` | Jev/OpenAI-форма со списком модели |
| POST | `/v1/systemone` | Jev-форма ответа на типизированные вопросы |

Слушает только `127.0.0.1`. Лимит тела запроса — 4 МБ.

## Изменённые файлы движка

```
engine/sequence.go   SeqStats: HeadTokens, HeadTruncated, StateTokens, StateKept,
                     OptionTokens + методы Collapsed()/StateDropped()
engine/model.go      Answer: state_dropped, head_truncated, temperature;
                     Result: state_tokens, state_dropped_max, state_truncated;
                     DecideWith / CountWith (переопределение max_len), Count()
engine/checkpoint.go НОВЫЙ: IdentifyCheckpoint (манифест или runtime-хэш), Checkpoint ID
server/server.go     /info + checkpoint; /decide + budget; /count; /v1/models; /v1/systemone
cmd/laya-server/main.go  идентификация чекпоинта при старте + лог
```

Сборка и проверка: `build.cmd` (gofmt + vet + тесты + `bin\laya-server.exe`).
Перезапуск: `stop-laya.cmd` → `build.cmd` → `start-laya.cmd`.

## Границы, оставленные сознательно

- Сервис держит **одну** модель: `/v1/systemone` принимает поле `model`, но
  проверяет только префикс `laya` — это осознанное упрощение, а не недосмотр.
- `options` в теле `/decide` принимается для совместимости и не используется.
- `confidence` (энтропия) остаётся в ответе, но порог по ней ставить нельзя —
  калибрована только `answer_confidence` (max p). Это по-прежнему записано в
  README движка.
- Никаких сетевых вызовов при старте: веса и словарь берутся только локально.
