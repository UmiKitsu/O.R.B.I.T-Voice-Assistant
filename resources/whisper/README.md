# Local whisper.cpp resources

Place these trusted local files in this directory before running speech recognition or packaging:

- `whisper-cli.exe` - the official Windows `whisper.cpp` command-line executable
- the official runtime DLLs shipped beside that executable
- `ggml-small.bin` - the multilingual small model

T.I.T.A.N. resolves only these fixed filenames. It never accepts an executable, model, or output path from the renderer, the user, or the AI model. Packaged builds copy this directory to the application's resources.
