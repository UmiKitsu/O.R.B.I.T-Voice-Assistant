# orbit-voice-assistant

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Local Whisper model

The 488 MB multilingual Whisper Small model is intentionally excluded from Git. Download and verify it before development:

```bash
$ npm run setup:whisper
```

The fixed Orbit wake-word model is bundled in the repository. Verify its pinned
checksums before development or packaging:

```bash
npm run setup:wake-word
```

Production builds run this check automatically and download the model only when it is missing or invalid.

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
