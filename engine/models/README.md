# Model files are not included in this repository.
#
# Put the legally obtained Laya multilingual checkpoint here:
#
#   models\multilingual-fp16.onnx   646,870,871 bytes
#     sha256 0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c
#
#   models\tokenizer.json            34,363,188 bytes
#     sha256 609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f
#
# One-time download from the public sources used by the Laya project:
#
#   powershell -ExecutionPolicy Bypass -File tools\fetch-model.ps1
#   powershell -ExecutionPolicy Bypass -File tools\verify-model.ps1
#
# The running service never downloads anything; these files are read locally.
# Do not commit the weights.
#
# The model is Apache-2.0. See ..\..\NOTICE.md.
