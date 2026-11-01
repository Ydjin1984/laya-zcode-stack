# Установка (кратко, по-русски)

Полная инструкция — [INSTALL.md](INSTALL.md).

## 1. Что нужно

- Windows 10/11 x64, ZCode 3.17+, Node.js 20+.
- NVIDIA GPU + CUDA 12 + cuDNN 9 — для GPU; без GPU можно `engine\start-laya.cmd /cpu`.
- ~1.6 ГБ на модель, ONNX Runtime и CUDA DLL.
- Go 1.26+ и gcc — только если хотите пересобирать; готовые exe уже в репозитории.

## 2. Клонировать

```cmd
git clone https://github.com/Ydjin1984/laya-zcode-stack.git
cd laya-zcode-stack
```

## 3. Скачать модель (в репозитории её нет)

```cmd
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-model.ps1
powershell -ExecutionPolicy Bypass -File engine\tools\verify-model.ps1
```

Файлы кладутся в `engine\models\`:

- `multilingual-fp16.onnx` — 646 870 871 байт, sha256 `0b095e005a4c...`;
- `tokenizer.json` — 34 363 188 байт, sha256 `609d8f4c067c...`.

Если Hugging Face недоступен, положите те же файлы вручную.

## 4. ONNX Runtime + CUDA

```cmd
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-runtime.ps1
```

Скрипт скачивает ONNX Runtime **1.25.0** GPU DLL в `engine\bin\`.

CUDA 12 + cuDNN 9 нужно поставить отдельно; DLL:

```
cudart64_12.dll
cublas64_12.dll
cublasLt64_12.dll
cudnn64_9.dll
cufft64_11.dll
```

Положите их в `engine\third_party\cuda12\` (или установите CUDA 12.6 + cuDNN 9
системно).

## 5. Запустить движок

```cmd
engine\start-laya.cmd
curl.exe http://127.0.0.1:8095/ready
```

Ожидается `{"ready":true}`.

## 6. Подключить плагин

1. ZCode → **Settings → Plugin Management → Add marketplace**.
2. Укажите **корень репозитория** (там, где `marketplace.json`).
3. Включите **DaVinci x Laya: local decisions**.
4. Начните **новую** сессию ZCode.

## 7. Проверить

```cmd
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

В новой сессии попросите агента:

> Вызови `laya_health` и `laya_search` по слову "discount" в этом репозитории.
> Файлы не меняй.

Агент должен увидеть 13 `laya_*` инструментов.

## 8. Если что-то не так

- Порт 8095 занят: `engine\stop-laya.cmd`, затем снова `engine\start-laya.cmd`.
- Нет `onnxruntime_providers_cuda.dll`: `fetch-runtime.ps1`.
- Нет CUDA DLL: установите CUDA 12.6 + cuDNN 9 или используйте `/cpu`.
- ZCode не видит инструменты: проверьте, что плагин включён, и начните новую сессию.
