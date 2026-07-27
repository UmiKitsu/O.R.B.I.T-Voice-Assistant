# Local wake-word resources

The ONNX files and `tokens.txt` are from the Apache-2.0 licensed
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` release.

T.I.T.A.N. loads only these fixed local files and uses the CPU int8 models with
one inference thread. `keywords.txt` contains the fixed “Hey TITAN” token
sequence. Audio processed by the detector is not written to disk.