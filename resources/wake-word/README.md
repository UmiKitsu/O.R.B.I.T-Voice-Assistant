# Local wake-word resources

The ONNX files and `tokens.txt` are from the Apache-2.0 licensed
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` release.

T.I.T.A.N. loads only these fixed local files and uses the CPU int8 models with
one inference thread. `keywords.txt` contains the fixed “TITAN” token
sequence. Audio processed by the detector is not written to disk.

The keywords.raw.txt source includes TITAN plus TAITAN and TAYTAN pronunciation variants. keywords.txt was generated from that source with the official sherpa-onnx-cli text2token BPE tokenizer and the matching GigaSpeech pe.model; do not hand-author token sequences.
