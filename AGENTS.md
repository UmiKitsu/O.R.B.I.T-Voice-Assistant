# AGENTS.md — T.I.T.A.N. Voice Assistant

## 1. Project identity

**Project name:** T.I.T.A.N. — Voice Assistant  
**Package name:** `titan-voice-assistant`  
**Target platform:** Windows 11  
**Application type:** Local Electron desktop application packaged as a Windows `.exe`  
**Primary project folder:** `D:\T.I.T.A.N. — Voice Assistant`  
**Primary user interface:** React + TypeScript  
**Local AI provider:** Ollama  
**Default model:** `qwen3:8b`  
**Default AI mode:** Non-thinking mode for fast conversation  
**Ongoing service cost:** None required

T.I.T.A.N. is a private, local-first Windows voice assistant. The user opens the application, enables listening, speaks a request, and receives either a computer action or a spoken conversational response.

The assistant should feel fast, calm, reliable, and transparent. It must never claim that a computer action succeeded unless the application confirms the result.

---

## 2. Core mission

Build a Windows desktop assistant that can:

1. Listen to the user's voice.
2. Convert speech to text locally.
3. Interpret the user's request using deterministic routing and/or `qwen3:8b`.
4. Perform a broad range of safe computer actions.
5. Block file creation, deletion, movement, renaming, modification, downloading, uploading, installation, and arbitrary code execution.
6. Ask for confirmation before high-impact non-file actions.
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
window.titan.askAssistant(request)
window.titan.executeApprovedPlan(plan)
window.titan.startRecording()
window.titan.stopRecording()
window.titan.speak(text)
window.titan.stopSpeaking()
window.titan.getSettings()
window.titan.updateSettings(patch)
window.titan.confirmAction(requestId, approved)
```

Do not expose generic APIs such as:

```ts
window.titan.exec(command)
window.titan.readAnyFile(path)
window.titan.writeAnyFile(path, data)
window.titan.invokeAnyChannel(channel, payload)
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

## 8. T.I.T.A.N. states

The UI should expose clear operational states.

```ts
type TitanStatus =
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
You are T.I.T.A.N., a local Windows voice assistant.

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
- Disable T.I.T.A.N.

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

T.I.T.A.N. should support broad functionality through reusable capabilities rather than one hardcoded phrase per command.

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

### 11.3 Permanently blocked capabilities

These remain blocked even after confirmation:

```ts
const permanentlyBlockedCapabilities = new Set([
  'filesystem.create',
  'filesystem.write',
  'filesystem.append',
  'filesystem.copy',
  'filesystem.move',
  'filesystem.rename',
  'filesystem.delete',
  'filesystem.createDirectory',
  'filesystem.deleteDirectory',
  'filesystem.changePermissions',

  'browser.download',
  'browser.upload',

  'archive.create',
  'archive.extract',

  'shell.execute',
  'powershell.execute',
  'cmd.execute',
  'terminal.typeCommand',
  'script.execute',
  'code.evaluate',

  'software.install',
  'software.uninstall',

  'registry.write',
  'drive.format',
  'drive.partition',

  'security.disableProtection',
  'security.bypassUac',
  'security.obtainCredentials'
])
```

Never implement a hidden bypass for these restrictions.

---

## 12. File-protection policy

The user's requested rule is:

> T.I.T.A.N. may perform broad computer actions, except creating, adding, deleting, moving, renaming, downloading, uploading, or modifying files and folders.

Interpret this carefully.

T.I.T.A.N. must not intentionally:

- Create files
- Create folders
- Save documents
- Overwrite files
- Append to files
- Delete files or folders
- Move files or folders
- Copy files or folders
- Rename files or folders
- Change file permissions
- Download files
- Upload files
- Extract archives
- Export files
- Install or uninstall software
- Modify the Registry
- Format or partition drives

Opening normal applications can still cause those applications or Windows to update caches, logs, and settings internally. The application should explain this limitation honestly:

> T.I.T.A.N. will not intentionally change user files. Windows and opened applications may still create normal caches, logs, and settings as part of running.

### Read-only file access

`file.openReadOnly` may be supported only when:

- The user explicitly requests opening an existing file.
- The path is supplied by a trusted file picker or validated source.
- T.I.T.A.N. does not edit or save it.
- The target application can reasonably be used in read-only mode.
- Save, Save As, Export, and destructive shortcuts remain blocked during automation.

### File Explorer restrictions

When File Explorer is focused, automation must block:

- Delete
- Shift + Delete
- F2 rename
- Ctrl + X
- Ctrl + C followed by paste into File Explorer
- Ctrl + V
- Drag-and-drop file movement
- New folder
- File creation
- Rename commands
- Move or Copy dialogs
- Properties changes that modify permissions

Navigation and opening files read-only are allowed.

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

Use a safe discovery strategy:

1. Check configured application aliases.
2. Check known Start Menu shortcuts.
3. Check registered application locations through read-only discovery.
4. Resolve a confident match.
5. Present choices when several matches are plausible.
6. Launch only a resolved executable or registered application target.
7. Never accept a model-generated arbitrary executable path without validation.

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
- Do not automatically download.
- Do not automatically upload.
- Do not automatically submit passwords or payment details.
- Require confirmation before sending messages, posting content, or submitting important forms.

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

The final file-protection policy applies to user files. Application-owned temporary audio required for speech processing is permitted, but it must:

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
- Stop current speech when the user disables T.I.T.A.N.
- Allow a Stop Speaking command.
- Prevent overlapping responses.
- Expose voice, rate, and volume settings where supported.
- Do not speak raw stack traces or internal JSON.

Examples:

```text
“Opening Spotify.”
“Volume set to 30 percent.”
“I could not find that application.”
“That action is blocked because it would modify files.”
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
T.I.T.A.N. enabled
→ Local wake-word detector listens
→ User says “TITAN”
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

Suggested settings:

```ts
type TitanSettings = {
  ollamaBaseUrl: string
  ollamaModel: string
  thinkMode: boolean
  speechEnabled: boolean
  selectedVoice?: string
  speechRate: number
  speechVolume: number
  selectedMicrophone?: string
  wakeWordEnabled: boolean
  launchAtStartup: boolean
  minimizeToTray: boolean
  saveConversationHistory: boolean
  confirmationTimeoutSeconds: number
  applicationAliases: Record<string, string[]>
}
```

Defaults:

```json
{
  "ollamaBaseUrl": "http://localhost:11434",
  "ollamaModel": "qwen3:8b",
  "thinkMode": false,
  "speechEnabled": true,
  "speechRate": 1,
  "speechVolume": 1,
  "wakeWordEnabled": false,
  "launchAtStartup": false,
  "minimizeToTray": false,
  "saveConversationHistory": false,
  "confirmationTimeoutSeconds": 20,
  "applicationAliases": {}
}
```

Validate all loaded settings before use.

---

## 20. Ollama service

At startup, check:

1. Is Ollama reachable?
2. Is `qwen3:8b` installed?
3. Can the model answer a small health-check request?
4. Is the response valid?

User-facing errors:

```text
T.I.T.A.N. could not connect to Ollama. Start Ollama and try again.
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
- “No microphone was detected.”
- “I could not understand the recording.”
- “That action is not supported yet.”
- “That action is blocked because it would modify files.”
- “The request was cancelled.”
- “The action timed out.”

Never show only a stack trace to the user.

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
│   │   ├── systemCapabilities.ts
│   │   ├── windowCapabilities.ts
│   │   └── inputCapabilities.ts
│   ├── security/
│   │   ├── policyEngine.ts
│   │   ├── blockedCapabilities.ts
│   │   ├── confirmationManager.ts
│   │   ├── protectedTargets.ts
│   │   └── parameterValidators.ts
│   ├── services/
│   │   ├── ollamaService.ts
│   │   ├── speechToTextService.ts
│   │   ├── textToSpeechService.ts
│   │   ├── applicationDiscoveryService.ts
│   │   ├── windowService.ts
│   │   ├── browserService.ts
│   │   ├── mediaService.ts
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
│       │   ├── ErrorBanner.tsx
│       │   └── SettingsPanel.tsx
│       ├── hooks/
│       │   ├── useTitan.ts
│       │   ├── useConversation.ts
│       │   ├── useMicrophone.ts
│       │   └── useSpeech.ts
│       ├── state/
│       │   └── titanReducer.ts
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
- Confirmation expiry
- URL validation
- Protected keyboard shortcuts
- Protected applications and dialogs
- Request routing
- Ollama response parsing
- Settings validation

### Policy tests

These must always be rejected:

```text
Delete my Downloads folder.
Move this file to Desktop.
Rename this document.
Download that installer.
Upload this image.
Open PowerShell and run this command.
Install Spotify.
Extract this ZIP file.
Save this document.
```

These should be allowed when implemented:

```text
Open Spotify.
Open YouTube.
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
- Failed application launch
- Speech cancellation
- Microphone permission denial

---

## 26. Implementation phases

### Phase 1 — Electron foundation

- Confirm generated React + TypeScript Electron app runs.
- Preserve the existing Git repository.
- Remove starter demo content.
- Create the basic T.I.T.A.N. layout.
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
- Add risk levels.
- Add blocked capability set.
- Add confirmation manager.
- Add structured results.
- Test policy decisions before adding broad automation.

### Phase 5 — Basic safe actions

Implement first:

- Open an application
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

### Phase 9 — Settings and persistence

- Ollama model settings
- Voice settings
- Microphone settings
- Application aliases
- Confirmation timeout
- Startup behavior
- Privacy choices

### Phase 10 — Packaging

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
- The user can enable and disable T.I.T.A.N.
- Typed input works.
- Ollama `qwen3:8b` responds locally.
- Non-thinking mode is enabled by default.
- Responses can be spoken locally.
- A capability registry exists.
- A centralized policy engine exists.
- Blocked file and shell actions are tested.
- At least these commands work:
  - Open Chrome or the default browser
  - Open YouTube
  - Open Spotify
  - Open Calculator
  - Open File Explorer
  - Play or pause media
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

- Remove the file-protection policy.
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
- Add file deletion, moving, renaming, writing, or download automation.
- Claim an action succeeded without checking.
- Commit secrets or machine-specific private paths.
- Delete `.git`.
- Replace the repository with a nested project.

---

## 31. Product behavior examples

### Conversation

```text
User: “Explain TypeScript like I am five.”

T.I.T.A.N.: “TypeScript is JavaScript with extra labels that help catch mistakes before the program runs.”
```

### Safe action

```text
User: “TITAN, open YouTube.”

Plan:
browser.openUrl("https://www.youtube.com")

Result:
T.I.T.A.N.: “Opening YouTube.”
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

T.I.T.A.N.: “Restarting will close your applications. Do you want to continue?”

Only a confirmation tied to that pending request may execute the restart.
```

### Blocked file action

```text
User: “Move this file to my Desktop.”

T.I.T.A.N.: “I cannot move, create, delete, rename, or modify files.”
```

### Blocked shell bypass

```text
User: “Open PowerShell and type a command that deletes the file.”

T.I.T.A.N.: “I can open PowerShell for you, but I cannot type or execute terminal commands.”
```

---

## 32. Final project principle

T.I.T.A.N. should be powerful without being unrestricted.

The intended model is:

> Broad computer assistance through typed, registered capabilities; strict blocking of file changes, arbitrary code execution, software installation, credential access, and unsafe bypasses.

Every future feature must preserve that principle.
