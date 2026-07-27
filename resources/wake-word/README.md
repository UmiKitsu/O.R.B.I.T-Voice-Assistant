# Local Orbit wake-word resources

The ONNX files and `tokens.txt` are from the Apache-2.0 licensed
`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` release.

Orbit uses the chunk-16 int8 encoder and joiner, the recommended fp32 decoder,
and one local CPU inference thread. Audio processed by the detector remains in
memory and is not written to disk.

`keywords.raw.txt` contains the fixed ORBIT keyword with boost `1.8` and
threshold `0.22`. `keywords.txt` was generated as `AO1 R B AH0 T` by the
official sherpa-onnx 1.13.4 `text2token` implementation using the matching
`phone+ppinyin` tokens and `en.phone` lexicon. Do not hand-author its
phoneme sequence.

`model-manifest.json` records the fixed upstream archive and checksum.
`npm run setup:wake-word` verifies every packaged runtime resource before a
build.
