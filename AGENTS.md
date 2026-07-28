# AGENTS.md — Orbit Voice Assistant

## 1. Project identity

**Project name:** Orbit — Voice Assistant
**Package name:** `orbit-voice-assistant`
**Target platform:** Windows 11  
**Application type:** Local Electron desktop application packaged as a Windows `.exe`  
**Primary project folder:** `D:\T.I.T.A.N. — Voice Assistant`  
**Primary user interface:** React + TypeScript  
**Local AI provider:** Ollama  
**Default model:** `qwen3:8b`  
**Default AI mode:** Non-thinking mode for fast conversation  
**Ongoing service cost:** None required

Orbit is a private, local-first Windows voice assistant. The user opens the application, enables listening, speaks a request, and receives either a computer action or a spoken conversational response.

The assistant should feel fast, calm, reliable, and transparent. It must never claim that a computer action succeeded unless the application confirms the result.

---

## 2. Core mission

Build a Windows desktop assistant that can:

1. Listen to the user's voice.
2. Convert speech to text locally.
3. Interpret the user's request using deterministic routing and/or `qwen3:8b`.
4. Perform a broad range of safe computer actions.
5. Allow broad registered computer actions, including selected file operations and starting local installers, with exact four-digit PIN authorization for dangerous actions.
6. Ask for normal confirmation before high-impact reversible actions and require the security PIN before protected file or installer actions.
7. Answer general questions through Ollama.
8. Speak responses through local text-to-speech.
9. Preserve the current conversation context.
10. Run as a normal Windows `.exe` without a paid API.

The central design rule is:

> The AI may understand and plan a request, but only the application may decide which actions are allowed and execute them.

---

## 3. Non-negotiable requirements

All coding agents working on this repository must preserve the following requirements.

### 3.1 Local-first operation

Normal operation must not require:

- OpenAI API access
- ChatGPT Plus integration
- Paid speech-to-text services
- Paid text-to-speech services
- A cloud server
- A user account
- A recurring subscription

Use local components whenever practical:

- Ollama for AI
- `qwen3:8b` for conversation and command interpretation
- Whisper.cpp or another local Whisper implementation for speech-to-text
- Windows speech APIs or another local engine for text-to-speech
- Electron and Node.js for desktop integration

### 3.2 Windows `.exe`

The finished application must be packageable into a Windows installer or executable.

Development may use:

- Electron
- electron-vite
- React
- TypeScript
- electron-builder or an equivalent free packaging tool

An unsigned development build may trigger Windows SmartScreen. Paid code signing is not required for the personal MVP.

### 3.3 Preserve Git history

The repository already contains a `.git` directory.

Never:

- Delete `.git`
- Reinitialize Git unless explicitly requested
- Create the actual application inside an accidental nested project folder
- Remove existing history or remotes
- Force-push without explicit permission

Before large changes, inspect:

```powershell
git status
git branch
git remote -v
```

### 3.4 No unrestricted shell execution

Never give Qwen, the renderer, or voice input direct access to:

- `child_process.exec` with arbitrary user or model text
- Arbitrary PowerShell
- Arbitrary Command Prompt commands
- Arbitrary scripts
- Dynamic `eval`
- Registry writes
- Installer execution
- Administrator elevation
- UAC bypasses

All operating-system actions must use registered, typed capabilities with validated parameters.

---

## 4. Current development machine

The main development machine currently has:

- Windows 11 Pro
- AMD Ryzen 5 7600
- 32 GB RAM
- AMD Radeon RX 7700 XT
- 12 GB VRAM

Ollama has already been tested with:

```text
Model: qwen3:8b
Processor: 100% GPU
Context: 4096
```

The default model is appropriate for fast local conversation and command classification.

---

## 5. Technology stack

### Required core stack

| Area | Technology |
|---|---|
| Desktop runtime | Electron |
| Frontend | React |
| Language | TypeScript |
| Build tooling | electron-vite |
| AI runtime | Ollama |
| AI model | `qwen3:8b` |
| Speech-to-text | Whisper.cpp or compatible local Whisper implementation |
| Text-to-speech | Windows local speech APIs |
| Packaging | electron-builder or project-provided packager |
| Version control | Git |

### Optional local libraries

Use only when they clearly simplify the implementation:

- `zod` for runtime schema validation
- `electron-store` for local settings
- `pino` or another lightweight logger
- `vitest` for unit tests
- `playwright` for limited UI tests
- A maintained Windows media-key or native-control library
- A maintained window-management library

Avoid adding unnecessary dependencies.

---

## 6. High-level architecture

```text
React renderer
    |
    | Typed, narrow preload API
    v
Electron preload
    |
    | IPC
    v
Electron main process
    |
    +--> Command router
    |
    +--> Action planner
    |
    +--> Security policy engine
    |
    +--> Capability registry
    |
    +--> Windows action executors
    |
    +--> Ollama service
    |
    +--> Speech-to-text service
    |
    +--> Text-to-speech service
    |
    +--> Settings and logging
```

### Renderer responsibilities

The renderer handles:

- User interface
- Enable and Disable controls
- Push-to-talk controls
- Status indicators
- Conversation display
- Settings forms
- User confirmation dialogs
- Displaying errors
- Calling only typed preload methods

The renderer must not have unrestricted Node.js access.

### Preload responsibilities

The preload script exposes a small typed API, for example:

```ts
window.orbit.askAssistant(request)
window.orbit.executeApprovedPlan(plan)
window.orbit.startRecording()
window.orbit.stopRecording()
window.orbit.speak(text)
window.orbit.stopSpeaking()
window.orbit.getSettings()
window.orbit.updateSettings(patch)
window.orbit.confirmAction(requestId, approved)
```

Do not expose generic APIs such as:

```ts
window.orbit.exec(command)
window.orbit.readAnyFile(path)
window.orbit.writeAnyFile(path, data)
window.orbit.invokeAnyChannel(channel, payload)
```

### Main-process responsibilities

The main process handles:

- Ollama requests
- Application launching
- Window control
- Browser opening and search
- Media control
- Audio control
- System information
- Speech services
- Policy enforcement
- Confirmation state
- Local settings
- Logs
- Packaging behavior

---

## 7. Electron security requirements

Use secure defaults:

```ts
webPreferences: {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

Additional rules:

- Validate every IPC payload.
- Prefer request/response IPC over broad event channels.
- Keep an allowlist of IPC channel names.
- Never pass executable code through IPC.
- Do not load arbitrary remote web pages inside a privileged BrowserWindow.
- Restrict navigation and new-window creation.
- Open external URLs using a validated external-browser action.
- Allow only `http:` and `https:` URLs unless a capability explicitly supports another safe protocol.
- Block `file:`, `javascript:`, `data:`, and unexpected custom protocols.
- Keep all system actions in the main process.

---

## 8. Orbit states

The UI should expose clear operational states.

```ts
type OrbitStatus =
  | 'disabled'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'awaiting-confirmation'
  | 'executing'
  | 'speaking'
  | 'error'
```

Expected behavior:

- `disabled`: Microphone and command processing are inactive.
- `ready`: Enabled and waiting for user input.
- `listening`: Recording speech.
- `transcribing`: Converting audio to text.
- `thinking`: Ollama is generating a response or plan.
- `awaiting-confirmation`: A high-impact action needs approval.
- `executing`: A validated action plan is running.
- `speaking`: Text-to-speech is active.
- `error`: A recoverable problem occurred.

The app must never remain stuck in a busy state after a failed operation.

---

## 9. AI behavior

### Default model request

Use:

```json
{
  "model": "qwen3:8b",
  "think": false,
  "stream": true
}
```

Streaming is preferred for conversational text when it improves perceived speed. Structured action plans may use non-streaming responses when easier to validate reliably.

### System behavior

The assistant personality should be based on this concept:

```text
You are Orbit, a local Windows voice assistant.

Keep spoken responses clear and reasonably brief. Answer general questions
helpfully. Never claim that an action succeeded unless the application reports
success. Never invent computer state. When an action is blocked, explain the
restriction briefly. When a high-impact action requires confirmation, clearly
state what will happen.
```

### Conversation memory

Conversation memory should use typed messages:

```ts
type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}
```

The application should:

- Keep recent conversation context.
- Limit context size.
- Remove or summarize old messages when needed.
- Let the user clear the current conversation.
- Avoid saving conversations permanently unless the user enables that setting.

---

## 10. Request-routing strategy

Use a hybrid router.

### Step 1: Deterministic matching

Handle simple, common requests without calling the model when confidence is high:

- Play or pause
- Volume up or down
- Mute or unmute
- Open a known website
- Tell the time
- Tell the date
- Stop speaking
- Disable Orbit

### Step 2: Structured AI planning

For flexible requests, ask Qwen to return a structured plan.

Example:

```json
{
  "kind": "action_plan",
  "summary": "Open YouTube in the default browser",
  "actions": [
    {
      "capability": "browser.openUrl",
      "parameters": {
        "url": "https://www.youtube.com"
      }
    }
  ]
}
```

### Step 3: Conversation fallback

When no computer action is needed:

```json
{
  "kind": "conversation",
  "response": "A REST API is a way for software applications to communicate over HTTP."
}
```

### Step 4: Validation

Every model response must be parsed and validated against a strict runtime schema.

Never execute:

- Invalid JSON
- Unknown capabilities
- Missing parameters
- Extra executable fields
- Model-generated shell commands
- Model-generated code snippets as actions

---

## 11. Capability system

Orbit should support broad functionality through reusable capabilities rather than one hardcoded phrase per command.

### 11.1 Automatically allowed capabilities

Examples:

```ts
type AutomaticallyAllowedCapability =
  | 'application.launch'
  | 'application.focus'
  | 'application.minimize'
  | 'application.maximize'
  | 'application.restore'
  | 'application.closeSafe'
  | 'window.move'
  | 'window.resize'
  | 'browser.openUrl'
  | 'browser.searchWeb'
  | 'browser.searchYouTube'
  | 'browser.newTab'
  | 'browser.closeTab'
  | 'media.playPause'
  | 'media.next'
  | 'media.previous'
  | 'audio.volumeUp'
  | 'audio.volumeDown'
  | 'audio.setVolume'
  | 'audio.mute'
  | 'audio.unmute'
  | 'display.setBrightness'
  | 'system.getTime'
  | 'system.getDate'
  | 'system.getInformation'
  | 'system.getBattery'
  | 'system.getNetworkStatus'
  | 'clipboard.readText'
  | 'clipboard.writeText'
  | 'keyboard.typeSafeText'
  | 'mouse.clickSafe'
  | 'mouse.scroll'
  | 'folder.navigateReadOnly'
  | 'file.openReadOnly'
```

Every capability needs:

- A unique name
- A typed parameter schema
- A risk level
- An executor
- A result schema
- A timeout
- Audit-friendly status messages

### 11.2 Confirmation-required capabilities

These actions may run only after clear user confirmation:

```ts
type ConfirmationRequiredCapability =
  | 'system.lock'
  | 'system.signOut'
  | 'system.restart'
  | 'system.shutdown'
  | 'network.disableWifi'
  | 'network.disableBluetooth'
  | 'application.closePotentiallyUnsaved'
  | 'application.closeAll'
  | 'communication.sendMessage'
  | 'communication.sendEmail'
  | 'communication.joinCall'
  | 'communication.leaveCall'
  | 'settings.changeImportantSetting'
```

Confirmation requirements:

- State the exact action.
- Explain the immediate effect.
- Generate a unique request ID.
- Expire confirmation after a short period.
- Accept confirmation only for the pending request.
- Do not interpret an unrelated “yes” as confirmation.
- Cancel when the user says no, stop, cancel, or never mind.
- Re-check the policy immediately before execution.

### 11.3 PIN-required capabilities

Dangerous but intentional actions use the `pin-required` risk level. The currently implemented protected capabilities are:

```ts
type PinRequiredCapability =
  | 'filesystem.create'
  | 'filesystem.write'
  | 'filesystem.copy'
  | 'filesystem.move'
  | 'filesystem.rename'
  | 'filesystem.delete'
  | 'filesystem.createDirectory'
  | 'software.install'
```

PIN authorization requirements:

- Use exactly four numeric digits.
- Never store the PIN as plain text.
- Derive a verifier with a random salt and `scrypt`.
- Protect the stored verifier with Electron `safeStorage` when OS encryption is available.
- Never return the PIN, salt, or verifier through IPC.
- Never log, display, repeat, synthesize, or add the PIN to conversation history.
- Bind approval to one request ID, one capability, and one exact parameter fingerprint.
- Consume authorization once and reject replay.
- Keep a wrong-PIN request pending so the user may retry until expiry or lockout.
- Temporarily lock verification after repeated wrong attempts.
- Require the current PIN before changing it.
- If no PIN exists, require PIN setup before authorization and then require the new PIN for the pending action.
- Spoken PIN entry is accepted only while a PIN challenge is active and bypasses normal AI routing and transcript display.

### 11.4 Permanently blocked capabilities

A PIN must never authorize behavior that bypasses the capability system or compromises the machine:

```ts
const permanentlyBlockedCapabilities = new Set([
  'shell.execute',
  'powershell.execute',
  'cmd.execute',
  'terminal.typeCommand',
  'script.execute',
  'code.evaluate',

  'registry.write',
  'drive.format',
  'drive.partition',

  'security.disableProtection',
  'security.bypassUac',
  'security.obtainCredentials'
])
```

Capabilities that are not implemented with a typed schema and tested executor, including generic browser upload/download, archive automation, permission changes, and software uninstall, must remain unregistered or blocked until their full protected implementation exists. Never create a hidden bypass.

---

## 12. Protected file and installer policy

Orbit may intentionally change ordinary user files only through registered `pin-required` capabilities. Generic keyboard or mouse automation must not imitate destructive File Explorer shortcuts as a bypass.

Current behavior:

- `filesystem.delete` sends an existing file or folder to the Windows Recycle Bin rather than permanently deleting it.
- `filesystem.move` moves an item only when the destination does not already exist.
- `filesystem.rename` accepts an existing absolute path and a validated new base name.
- `filesystem.copy` currently copies files and refuses to overwrite an existing destination.
- `filesystem.createDirectory` creates one requested directory.
- `filesystem.create` creates a UTF-8 text file without overwriting.
- `filesystem.write` overwrites a UTF-8 text file only after exact PIN authorization.
- `software.install` starts only a local `.exe` or `.msi` with no model-generated command-line arguments. The user must review the installer and personally handle Windows UAC.

All protected file capabilities must:

- Require complete absolute paths.
- Validate parameters before requesting the PIN.
- Show the exact path and action in the authorization dialog.
- Reject destination overwrite unless a capability explicitly and visibly supports it.
- Reject drive roots and critical Windows, Program Files, and ProgramData paths.
- Return an exact success or failure result.
- Never claim completion merely because a process was started.

The security PIN is authorization, not a general unrestricted mode. It does not permit arbitrary shell commands, UAC bypass, credential access, security disabling, Registry writes, drive formatting, or model-generated code execution.

### File Explorer and generic-input restrictions

When File Explorer or a save dialog is focused, generic keyboard and mouse automation must still block destructive shortcuts and dialogs such as Delete, Shift+Delete, F2, Ctrl+X, Ctrl+V, Save, Save As, drag-and-drop movement, and permission editing. The assistant must use an exact typed file capability instead.

---

## 13. Safe keyboard and mouse automation

Keyboard and mouse control is powerful and must be context-aware.

### Allowed examples

- Type a search query into a browser search box.
- Type a message into a chat input, with confirmation before sending when appropriate.
- Click media buttons.
- Click navigation controls.
- Scroll a page.
- Move or resize windows.
- Select a browser tab.
- Enter text into non-administrative forms.

### Protected targets

Do not automatically type into or click through:

- PowerShell
- Command Prompt
- Windows Terminal
- Registry Editor
- Disk Management
- Local Group Policy Editor
- Task Scheduler configuration
- Developer consoles
- Script interpreters
- Installer windows
- Uninstaller windows
- UAC prompts
- Credential dialogs
- Password fields
- File Save dialogs
- File Upload dialogs
- File Download dialogs
- Archive extraction dialogs

### Blocked shortcuts

At minimum block:

```text
Ctrl + S
Ctrl + Shift + S
Shift + Delete
F2 in File Explorer
Delete in File Explorer
Ctrl + X in File Explorer
Ctrl + V in File Explorer
Win + R followed by automatic command entry
```

`Alt + F4` must require caution when the active application may contain unsaved work.

---

## 14. Application launching

Do not hardcode only a tiny application list.

Use the implemented discovery strategy:

1. Check built-in application mappings and configured application aliases.
2. Recursively index `.lnk` and `.url` shortcuts from the current-user and all-users Start Menu folders.
3. Index current-user and public Desktop shortcuts.
4. Normalize display names and common suffixes such as `Player`, `Launcher`, and `App`, so requests such as “Roblox” can match “Roblox Player”.
5. Prefer exact aliases, then high-confidence partial matches.
6. Launch only the resolved built-in executable, known executable, or discovered shortcut with `shell: false`.
7. Cache shortcut discovery briefly and allow explicit cache invalidation.
8. Never accept a model-generated arbitrary executable path as an application launch target.

Support aliases such as:

```json
{
  "chrome": ["google chrome", "chrome", "browser"],
  "spotify": ["spotify", "music"],
  "vscode": ["visual studio code", "vs code", "code editor"]
}
```

Application closure must report whether the application was found and whether the close request succeeded.

---

## 15. Browser actions

Allowed browser capabilities include:

- Open a validated URL.
- Search the web.
- Search YouTube.
- Open or close tabs.
- Focus the browser.
- Navigate backward or forward.
- Scroll.
- Read visible page text when implemented safely.

URL policy:

- Allow `https:` and optionally `http:`.
- Normalize user-provided domains.
- Reject `javascript:`, `data:`, `file:`, and unknown schemes.
- Do not automatically download or upload until a dedicated PIN-required capability with destination/source validation, size limits, and tests is implemented.
- Do not automatically submit passwords or payment details.
- Require confirmation before sending messages, posting content, or submitting important forms.

### Music playback providers

Orbit supports Spotify and YouTube through typed playback capabilities:

```ts
type MusicPlaybackCapability =
  | 'spotify.playSearch'
  | 'youtube.playSearch'
  | 'music.playSearch'
```

Provider behavior:

1. `spotify.playSearch` and unqualified `music.playSearch` use the downloaded Spotify desktop application and work with Spotify Free.
2. Spotify playback must not require a Client ID, OAuth connection, Premium subscription, or a visible Music Playback settings panel.
3. Orbit opens Spotify Quick Search with `Ctrl+K`, types the requested song, uses Spotify's keyboard result navigation, and activates the selected top result only while Spotify remains the foreground safe target.
4. A generic Spotify window title is not proof of failure. If the complete selection sequence succeeded and Spotify remained active, report that Orbit started the top result without claiming API-level verification.
5. Play/pause, next, previous, and skip commands use fixed Windows media keys. Commands such as “skip it,” “skip this song,” and “go back on Spotify” must route deterministically.
6. Explicit “on YouTube” commands may open YouTube search results in the default browser.
7. Opening YouTube results is not verified playback. Say that Orbit opened results; never claim a video is playing unless a future player integration confirms playback state.

---

## 16. Speech-to-text

The intended local speech-to-text solution is Whisper.cpp or another local Whisper implementation.

Initial implementation order:

1. Add push-to-talk recording.
2. Save or stream temporary audio in the application-controlled temporary area.
3. Transcribe locally.
4. Display the recognized text.
5. Let the user correct the text when needed.
6. Route the command.
7. Delete temporary recordings according to application privacy settings.

The protected file policy applies to user-requested actions. Application-owned temporary audio required for speech processing is permitted without a PIN, but it must:

- Use the operating system's application-data or temporary directory.
- Never write into the user's project or document folders without consent.
- Be deleted automatically after processing when practical.
- Never be treated as a user document.
- Never be uploaded.

The application must handle:

- No microphone
- Permission denied
- Silence
- Background noise
- Empty transcription
- Model unavailable
- Recording cancellation

---

## 17. Text-to-speech

Use a local Windows speech engine.

Required behavior:

- Speak assistant responses when voice output is enabled.
- Keep action confirmations brief.
- Stop current speech when the user disables Orbit
- Allow a Stop Speaking command.
- Prevent overlapping responses.
- Expose voice, rate, and volume settings where supported.
- Do not speak raw stack traces or internal JSON.

Examples:

```text
“Opening Spotify.”
“Volume set to 30 percent.”
“I could not find that application.”
“That protected action requires your four-digit security PIN.”
```

---

## 18. Enable and listening modes

The MVP should begin with controlled listening.

### Initial mode

```text
Open application
→ Press Enable
→ Press and hold or click the microphone button
→ Speak
→ Stop recording
→ Process request
```

### Later mode

A wake-word mode may be added later:

```text
Orbit enabled
→ Local wake-word detector listens
→ User says “ORBIT”
→ Command recording begins
```

Wake-word detection must remain local and clearly visible in the UI.

The user must always be able to:

- Disable listening
- Stop recording
- Stop speaking
- Cancel a pending action
- Clear the conversation

---

## 19. Settings

Store local settings in the application's proper user-data directory, not in arbitrary user folders.

Current settings shape:

```ts
type OrbitSettings = {
  ollamaBaseUrl: string
  ollamaModel: string
  thinkMode: boolean
  speechEngine: 'kokoro'
  kokoroVoice: KokoroVoice
  speechRate: number
  speechVolume: number
  launchAtStartup: boolean
  minimizeToTray: boolean
  saveConversationHistory: boolean
  confirmationTimeoutSeconds: number
  applicationAliases: Record<string, string[]>
  recognitionLanguage: 'auto' | 'en'
  wakeRecognitionMode: 'hybrid' | 'keyword-only'
  spotifyClientId: string
  spotifyPlaybackMode: 'desktop' | 'web-api'
  preferredMusicProvider: 'spotify' | 'youtube'
  musicFallbackEnabled: boolean
}
```

Validate all loaded settings before use.

The security PIN must not be stored in `OrbitSettings` or accepted by the generic settings IPC endpoint. Store only a salted `scrypt` verifier in the app user-data directory, encrypted with Electron `safeStorage` when available. Expose only `hasPin`, temporary-lock status, and an optional retry time to the renderer.

The Spotify Client ID is public application configuration and may be stored in `OrbitSettings`. Spotify access tokens, refresh tokens, PKCE verifiers, authorization codes, and OAuth state values are secrets or short-lived authorization material and must never be stored in `OrbitSettings`. Keep them in the main process and encrypt persisted authorization with `safeStorage`.

---

## 20. Ollama service

At startup, check:

1. Is Ollama reachable?
2. Is `qwen3:8b` installed?
3. Can the model answer a small health-check request?
4. Is the response valid?

User-facing errors:

```text
Orbit could not connect to Ollama. Start Ollama and try again.
```

```text
The qwen3:8b model is not installed. Run: ollama pull qwen3:8b
```

The application must not silently switch to a paid cloud provider.

Use timeouts and cancellation through `AbortController`.

---

## 21. Error handling

Every service should return a typed result.

Example:

```ts
type ActionResult<T = undefined> =
  | {
      ok: true
      message: string
      data?: T
    }
  | {
      ok: false
      code: string
      message: string
      recoverable: boolean
    }
```

Good error messages:

- “Ollama is not running.”
- “Spotify could not be found.”
- “Connect Spotify in Orbit settings before using direct playback.”
- “Spotify is connected, but no controllable playback device is available. Open Spotify once and try again.”
- “I could not start that on Spotify, so I opened YouTube results instead.”
- “No microphone was detected.”
- “I could not understand the recording.”
- “That action is not supported yet.”
- “That protected action requires your four-digit security PIN.”
- “That path is protected because it belongs to Windows or another critical system location.”
- “The request was cancelled.”
- “The action timed out.”

Never show only a stack trace to the user.

When Orbit is enabled, recoverable user-facing errors should be both displayed and spoken through the local TTS system. Do not speak internal error codes, stack traces, raw JSON, secrets, or the same unchanged error repeatedly in a tight loop.

---

## 22. Logging and privacy

Logs should be local and privacy-conscious.

Log useful operational events:

- Application started
- Ollama connected
- Model detected
- Recording started or stopped
- Transcription succeeded or failed
- Capability requested
- Policy allowed, confirmed, or blocked
- Action succeeded or failed
- Text-to-speech started or stopped
- Application closed

Do not log by default:

- Passwords
- Authentication tokens
- Spotify access tokens, refresh tokens, authorization codes, PKCE verifiers, or OAuth state values
- Clipboard contents
- Full conversations
- Microphone audio
- Personal messages
- File contents
- Sensitive system data

A detailed debug mode may be added, but it must be opt-in and clearly explained.

---

## 23. Suggested source structure

Adapt to the generated starter when necessary, but keep responsibilities separated.

```text
src/
├── main/
│   ├── index.ts
│   ├── ipc/
│   │   ├── assistantHandlers.ts
│   │   ├── actionHandlers.ts
│   │   ├── audioHandlers.ts
│   │   ├── settingsHandlers.ts
│   │   ├── securityHandlers.ts
│   │   ├── spotifyHandlers.ts
│   │   └── systemHandlers.ts
│   ├── assistant/
│   │   ├── commandRouter.ts
│   │   ├── actionPlanner.ts
│   │   ├── conversationManager.ts
│   │   └── prompts.ts
│   ├── capabilities/
│   │   ├── capabilityRegistry.ts
│   │   ├── capabilityTypes.ts
│   │   ├── applicationCapabilities.ts
│   │   ├── browserCapabilities.ts
│   │   ├── mediaCapabilities.ts
│   │   ├── spotifyCapabilities.ts
│   │   ├── filesystemCapabilities.ts
│   │   ├── softwareCapabilities.ts
│   │   ├── systemCapabilities.ts
│   │   ├── windowCapabilities.ts
│   │   └── inputCapabilities.ts
│   ├── security/
│   │   ├── policyEngine.ts
│   │   ├── blockedCapabilities.ts
│   │   ├── confirmationManager.ts
│   │   ├── securityPinService.ts
│   │   ├── protectedTargets.ts
│   │   └── parameterValidators.ts
│   ├── services/
│   │   ├── ollamaService.ts
│   │   ├── speechToTextService.ts
│   │   ├── textToSpeechService.ts
│   │   ├── applicationDiscoveryService.ts
│   │   ├── filesystemService.ts
│   │   ├── softwareInstallService.ts
│   │   ├── windowService.ts
│   │   ├── browserService.ts
│   │   ├── mediaService.ts
│   │   ├── spotifyAuthService.ts
│   │   ├── spotifyService.ts
│   │   ├── spotifyWebApiService.ts
│   │   ├── systemInfoService.ts
│   │   ├── settingsService.ts
│   │   └── loggerService.ts
│   └── shared/
│       ├── errors.ts
│       └── result.ts
├── preload/
│   ├── index.ts
│   └── index.d.ts
├── renderer/
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── EnableButton.tsx
│       │   ├── MicrophoneButton.tsx
│       │   ├── StatusIndicator.tsx
│       │   ├── ConversationPanel.tsx
│       │   ├── ConfirmationDialog.tsx
│       │   ├── SecurityPinSettings.tsx
│       │   ├── ErrorBanner.tsx
│       │   └── SettingsPanel.tsx
│       ├── hooks/
│       │   ├── useOrbit.ts
│       │   ├── useConversation.ts
│       │   ├── useMicrophone.ts
│       │   └── useSpeech.ts
│       ├── state/
│       │   └── orbitReducer.ts
│       ├── types/
│       │   └── global.d.ts
│       └── styles/
│           └── app.css
└── shared/
    ├── ipcChannels.ts
    ├── schemas.ts
    └── types.ts
```

---

## 24. Coding standards

### TypeScript

- Keep strict TypeScript enabled.
- Avoid `any`.
- Prefer discriminated unions.
- Validate external data at runtime.
- Use `unknown` before validation.
- Give exported functions explicit return types.
- Keep system APIs behind interfaces so they can be tested.

### React

- Use functional components.
- Keep system side effects outside presentational components.
- Use clear loading and error states.
- Avoid storing the same state in multiple places.
- Keep accessibility in mind.
- Every important control should be usable by keyboard.

### General

- Prefer small focused modules.
- Do not hide important behavior in large utility files.
- Do not duplicate policy rules.
- Keep the policy engine centralized.
- Add comments for security decisions, not obvious syntax.
- Handle errors explicitly.
- Use timeouts for external processes and local service calls.

---

## 25. Testing requirements

### Unit tests

Prioritize tests for:

- Capability schema validation
- Policy decisions
- Blocked capabilities
- Confirmation and PIN authorization expiry
- PIN creation, verification, change, retry, and lockout behavior
- PIN request binding and replay prevention
- PIN secrecy across IPC, logs, transcripts, conversation memory, and speech output
- URL validation
- Protected keyboard shortcuts
- Protected applications and dialogs
- Request routing
- Spotify PKCE verifier and challenge generation
- Spotify authorization status and encrypted token handling
- Spotify access-token refresh and reconnect behavior
- Exact Spotify track selection, device selection, playback start, and playback-state verification
- Spotify 401, 403, 429, no-device, cancellation, and network failures
- YouTube browser fallback and honest opened-results messaging
- Spoken user-facing errors without repeated loops or secret leakage
- Ollama response parsing
- Settings validation

### Policy tests

These must always be rejected even with a PIN:

```text
Run arbitrary PowerShell, Command Prompt, terminal, script, or model-generated code.
Bypass UAC.
Disable security protection.
Read passwords, browser cookies, or credentials.
Write to the Registry.
Format or partition a drive.
Modify a drive root or a protected Windows system directory.
```

These must produce an exact PIN challenge when their parameters are valid:

```text
Delete C:\\Users\\User\\Downloads\\old.txt.
Move C:\\Users\\User\\old.txt to C:\\Users\\User\\Desktop\\old.txt.
Copy C:\\Users\\User\\old.txt to C:\\Users\\User\\Desktop\\copy.txt.
Rename C:\\Users\\User\\old.txt to new.txt.
Create folder C:\\Users\\User\\Desktop\\New Folder.
Create or overwrite a text file using an absolute path.
Install C:\\Users\\User\\Downloads\\setup.exe.
```

These should be allowed automatically when implemented:

```text
Open Spotify.
Open YouTube.
Play Locked Out of Heaven on Spotify.
Play Locked Out of Heaven on YouTube.
Play Locked Out of Heaven using the preferred music provider.
Search Google for Electron tutorials.
Set the volume to 30 percent.
Pause the music.
Move Chrome to the second monitor.
Tell me the current time.
Open this existing PDF in read-only mode.
```

These should require confirmation:

```text
Restart the computer.
Shut down the computer.
Close all applications.
Turn off Wi-Fi.
Send this message.
```

### Integration tests

Test:

- Renderer to preload IPC
- Preload to main-process validation
- Ollama unavailable
- Ollama model missing
- Successful conversational response
- Valid action plan
- Blocked action plan
- Confirmation flow
- Typed and spoken PIN authorization flow
- Wrong-PIN retry and temporary lockout
- PIN setup while an action is pending
- Dynamic Start Menu and Desktop shortcut discovery
- Spotify renderer-to-main connection flow
- Spotify PKCE callback, token exchange, refresh, and disconnect flow
- Exact Spotify URI playback and verification
- Desktop Spotify fallback followed by optional YouTube fallback
- Failed application launch
- Speech cancellation
- Microphone permission denial

---

## 26. Implementation phases

### Phase 1 — Electron foundation

- Confirm generated React + TypeScript Electron app runs.
- Preserve the existing Git repository.
- Remove starter demo content.
- Create the basic Orbit layout.
- Add status state.
- Add typed preload and IPC foundation.

### Phase 2 — Ollama conversation

- Add Ollama health check.
- Add text input and Send button.
- Call `qwen3:8b`.
- Use `think: false`.
- Display streamed or completed responses.
- Handle cancellation and errors.
- Maintain current-session conversation history.

### Phase 3 — Local text-to-speech

- Add local Windows TTS.
- Speak responses.
- Add speech enable toggle.
- Add Stop Speaking.
- Prevent overlapping speech.

### Phase 4 — Capability and policy engine

- Define schemas.
- Add `automatic`, `confirmation-required`, `pin-required`, and `blocked` risk levels.
- Add blocked capability set.
- Add one-time confirmation and PIN authorization manager.
- Add structured results.
- Test policy decisions before adding broad automation.

### Phase 5 — Basic safe actions

Implement first:

- Open an application through built-in, known-path, Start Menu, and Desktop shortcut discovery
- Focus an application
- Open a URL
- Search the web
- Play or pause media
- Next or previous track
- Volume control
- Time and date
- System information

### Phase 6 — Structured AI action planning

- Ask Qwen for strict JSON.
- Validate every response.
- Route conversational requests separately.
- Reject unknown actions.
- Send validated plans through the policy engine.
- Report exact results.

### Phase 7 — Local speech-to-text

- Add push-to-talk.
- Record locally.
- Transcribe locally.
- Display recognized text.
- Let the user cancel.
- Route the transcription like typed input.

### Phase 8 — Broad window and safe input control

- Window movement and resizing
- Safe mouse clicks
- Safe scrolling
- Safe text entry
- Protected-window detection
- Blocked shortcuts
- Confirmation for sending content

### Phase 9 — Settings, PIN security, and persistence

- Ollama model settings
- Voice settings
- Microphone settings
- Application aliases
- Confirmation timeout
- Startup behavior
- Privacy choices
- Hidden four-digit PIN creation and change UI
- Salted `scrypt` verifier storage protected by `safeStorage`
- Wrong-attempt lockout
- Typed and spoken PIN challenge handling

### Phase 10 — Protected file and installer actions

- Recycle-Bin deletion
- File move, copy, and rename without silent overwrite
- Folder creation
- UTF-8 text-file creation and overwrite
- Local `.exe` and `.msi` installer launch without arbitrary arguments
- Protected-system-path rejection
- Exact action summaries and one-time PIN authorization

### Phase 11 — Reliable music playback

- Use the downloaded Spotify desktop application as the fixed Spotify playback path; it works with Spotify Free and needs no Client ID.
- Use Spotify Quick Search and keyboard result navigation while continuously validating the foreground Spotify target.
- Route play/pause, skip, next, and previous through fixed Windows media keys.
- Do not show a Music Playback settings panel.
- Keep explicit YouTube browser searches with honest status messaging.
- Display and speak recoverable playback errors when Orbit is enabled.

### Phase 12 — Packaging

- Set product name and icon.
- Configure Windows packaging.
- Produce installer or portable `.exe`.
- Verify application-data paths.
- Verify Ollama checks after installation.
- Test install, update strategy, and uninstall behavior.

---

## 27. MVP definition of done

The MVP is complete when:

- The Electron app opens on Windows.
- The interface clearly shows its status.
- The user can enable and disable Orbit
- Typed input works.
- Ollama `qwen3:8b` responds locally.
- Non-thinking mode is enabled by default.
- Responses can be spoken locally.
- A capability registry exists.
- A centralized policy engine exists.
- Arbitrary shell, credential, UAC-bypass, security-disable, Registry-write, and drive-management actions remain blocked and tested.
- A hidden four-digit security PIN can be created and changed only with the current PIN.
- PIN-protected actions are bound to one exact pending request and support hidden typed or non-displayed spoken PIN entry.
- Installed applications are discovered from Windows Start Menu and Desktop shortcuts instead of relying on a tiny hardcoded list.
- PIN-protected deletion, move, copy, rename, folder creation, text-file creation/overwrite, and local installer launch are registered and tested.
- Spotify uses the downloaded desktop application without Premium, a Client ID, or a visible Music Playback settings panel.
- Downloaded app control can search for a named song and can play/pause, skip, go next, and go previous through fixed Windows controls.
- Connected Web API playback searches for an exact track, selects a device, starts the exact URI, and verifies playback before reporting verified success.
- Recoverable assistant and playback errors are displayed and spoken when Orbit is enabled.
- At least these commands work:
  - Open Chrome or the default browser
  - Open YouTube
  - Open Spotify
  - Play a named song on Spotify
  - Play a named song on YouTube
  - Play a named song using the preferred provider
  - Open Calculator
  - Open File Explorer
  - Open Roblox or another installed application through shortcut discovery
  - Play or pause media
  - Skip to the next Spotify song
  - Return to the previous Spotify song
  - Volume up or down
  - Tell the time
- Errors are understandable.
- The project can be packaged as a Windows `.exe`.

Microphone transcription may be completed immediately after the text-controlled MVP if separating it makes debugging easier.

---

## 28. Commands for development

Use the scripts actually defined in `package.json`. Common commands may include:

```powershell
npm install
npm run dev
npm run lint
npm run typecheck
npm run test
npm run build
```

Before documenting or running a command, inspect `package.json` rather than assuming the script exists.

Useful checks:

```powershell
ollama list
ollama ps
git status
```

Do not change the Ollama model unless the user requests it.

---

## 29. Agent workflow

Whenever an AI coding agent starts work:

1. Read this file.
2. Inspect the repository structure.
3. Read `package.json`.
4. Read the Electron main, preload, and renderer entry points.
5. Run `git status`.
6. Identify the current implementation phase.
7. Make the smallest coherent change.
8. Preserve existing working behavior.
9. Run relevant type checks and tests.
10. Summarize exactly what changed.
11. State any errors or untested assumptions honestly.
12. Never claim success without verifying it.

When a request conflicts with the safety policy, preserve the safety policy and explain the conflict.

---

## 30. Actions agents must never take

Do not:

- Remove protected-path checks, PIN request binding, one-time consumption, lockout, or secret-handling rules.
- Add arbitrary shell execution.
- Give the renderer direct Node.js access.
- Turn off `contextIsolation`.
- Enable unrestricted `nodeIntegration`.
- Add UAC bypass behavior.
- Add credential collection.
- Read passwords or browser cookies.
- Add hidden startup persistence.
- Add stealth recording.
- Upload microphone recordings.
- Hide the microphone state.
- Execute model-generated code.
- Turn the PIN into a global unrestricted or long-lived unlocked mode.
- Store, log, display, repeat, synthesize, or add the PIN to conversation history.
- Verify the PIN in the renderer instead of the main process.
- Add destructive file, download, upload, archive, uninstall, or permission-changing behavior without a typed `pin-required` capability, exact parameter validation, protected-target checks, and tests.
- Permanently delete files when the capability promises Recycle Bin behavior.
- Start installers with model-generated command-line arguments or bypass UAC.
- Add a Spotify client secret to the desktop application.
- Expose, log, speak, send to Ollama, or place in settings any Spotify access token, refresh token, authorization code, PKCE verifier, or OAuth state value.
- Claim Spotify playback succeeded without verifying the current track and playback state.
- Claim YouTube playback succeeded when Orbit only opened browser search results.
- Claim an action succeeded without checking.
- Commit secrets or machine-specific private paths.
- Delete `.git`.
- Replace the repository with a nested project.

---

## 31. Product behavior examples

### Conversation

```text
User: “Explain TypeScript like I am five.”

Orbit: “TypeScript is JavaScript with extra labels that help catch mistakes before the program runs.”
```

### Safe action

```text
User: “ORBIT, open YouTube.”

Plan:
browser.openUrl("https://www.youtube.com")

Result:
Orbit: “Opening YouTube.”
```

### Broad application action

```text
User: “Open Blender and maximize it.”

Plan:
1. application.launch({ application: "Blender" })
2. application.maximize({ application: "Blender" })

The second action runs only after the first succeeds.
```

### Confirmation-required action

```text
User: “Restart the computer.”

Orbit: “Restarting will close your applications. Do you want to continue?”

Only a confirmation tied to that pending request may execute the restart.
```

### PIN-protected file action

```text
User: “Move C:\\Users\\User\\old.txt to C:\\Users\\User\\Desktop\\old.txt.”

Orbit: “Move C:\\Users\\User\\old.txt to C:\\Users\\User\\Desktop\\old.txt. This protected action requires your four-digit security PIN.”

The renderer shows a hidden PIN input. A spoken PIN is accepted only during this challenge and is never shown or routed to Ollama.
```

### Blocked shell bypass

```text
User: “Open PowerShell and type a command that deletes the file.”

Orbit: “I can open PowerShell for you, but I cannot type or execute terminal commands.”
```

---

## 32. Final project principle

Orbit should be powerful without being unrestricted.

The intended model is:

> Broad computer assistance through typed, registered capabilities; exact one-time PIN authorization for dangerous but intentional file and installer actions; permanent blocking of arbitrary code execution, credential access, UAC bypasses, security disabling, Registry writes, and destructive drive operations.

Every future feature must preserve that principle.
