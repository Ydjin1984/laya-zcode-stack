# CUDA 12 runtime DLLs

The engine expects these files in this directory (or on `PATH`):

```
cudart64_12.dll
cublas64_12.dll
cublasLt64_12.dll
cudnn64_9.dll
cufft64_11.dll
```

They are **not included** in this repository. Install CUDA 12.6 + cuDNN 9 from
NVIDIA (or another licensed distribution) and copy the DLLs here, or make them
available on `PATH`.

`start-laya.cmd` prepends this directory to `PATH` before starting
`bin\laya-server.exe`.

For CPU-only debugging, run `start-laya.cmd /cpu`; the CUDA DLLs are then not
required, but inference is much slower.
