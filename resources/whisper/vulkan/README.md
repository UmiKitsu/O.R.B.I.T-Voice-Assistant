# Pinned Whisper Vulkan runtime

This directory contains the Windows x64 `whisper-cli` runtime built locally from the official
`whisper.cpp` v1.9.1 release source with `GGML_VULKAN=ON`.

- Source: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1
- Source archive SHA-256: `98a57a88ef0e733b746544f8ea25157d3265fbf0dac5c32dbb527e6ef4dbfaac`
- Compiler: Microsoft Visual C++ 19.44.35228
- Vulkan SDK: 1.4.350.0
- Target: Windows x64

`npm run setup:whisper-vulkan` verifies every executable and DLL by exact size and SHA-256.
Orbit never accepts a renderer/model-provided executable or resource path.
