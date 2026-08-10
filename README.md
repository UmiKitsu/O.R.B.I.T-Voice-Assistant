# Orbit Voice Assistant

Orbit is a private Windows voice assistant that runs on your own computer. It can listen for voice commands, answer questions with Ollama, control supported apps, work with browser pages, and speak its replies aloud.

Speech recognition, text to speech, wake word detection, and chat all run locally. Normal use does not need a paid API or subscription.

## Project status

Orbit is still in active development. It is not a finished assistant yet. Some commands may fail, wake word detection may occasionally miss your voice, and parts of the interface may change between updates.

There are still many bugs to find and fix. More commands, better voice recognition, improved app control, and other features are planned for future versions. If you are trying Orbit now, expect an early version made for testing and learning.

## What Orbit is about

Orbit is being built as a local alternative to cloud voice assistants. The main goal is to let you talk to your Windows computer without sending every conversation to a paid online service.

Orbit currently brings several local tools together:

1. Whisper turns your microphone audio into text.

2. Ollama runs the language model that understands questions and requests.

3. Kokoro creates the spoken reply.

4. The Orbit wake word detector waits for you to say **Orbit**.

5. Registered computer controls handle supported Windows, browser, media, application, and file actions.

The language model can understand a request, but it does not receive unrestricted access to your computer. Orbit checks the requested action before running it.

## What Orbit can do

The available commands are growing, but the current project can handle tasks such as:

1. Answering normal questions with a local Ollama model.

2. Opening known applications and websites.

3. Searching the web or YouTube.

4. Playing and controlling music through supported Spotify and media controls.

5. Changing volume and using common window controls.

6. Reading selected computer, screen, clipboard, and playback information when supported.

7. Performing registered file and installer actions after security PIN approval.

8. Controlling supported Chrome pages with the optional Orbit browser extension.

Not every way of saying a command is supported yet. A feature shown in the interface may also be incomplete while the project is being developed.

## What you need

| Item | Why it is needed |
| --- | --- |
| Windows 11, 64 bit | Orbit is currently built and tested for Windows |
| [Node.js 22](https://nodejs.org/) | Installs dependencies and runs the development tools |
| [Git](https://git-scm.com/download/win) | Downloads the repository |
| [Ollama for Windows](https://ollama.com/download/windows) | Runs the local language model |
| A microphone | Needed for voice commands and wake word listening |
| Internet access during setup | Downloads packages and local speech models |

Keep at least 3 GB of free space for the project dependencies, speech models, and build files.

## Install Orbit from the source code

This repository contains the source code. You do not need to understand the code to try it, but you do need to install the tools below and enter a few commands in PowerShell.

### Option 1: Download with Git

Open PowerShell and clone the repository.

```powershell
git clone https://github.com/UmiKitsu/T.I.T.A.N.-Voice-Assistant.git
cd "T.I.T.A.N.-Voice-Assistant"
```

Git makes it easier to download future changes. To update your copy later, open PowerShell inside the project folder and run:

```powershell
git pull
```

### Option 2: Download a ZIP from GitHub

If you do not want to use Git:

1. Open the repository page on GitHub.

2. Select the green **Code** button.

3. Select **Download ZIP**.

4. Open your Downloads folder and extract the ZIP file.

5. Open the extracted project folder.

6. Click the File Explorer address bar, type `powershell`, and press Enter.

PowerShell should open inside the project folder. The next commands must be run from that folder.

### Check the required programs

Run these commands one at a time:

```powershell
node --version
npm --version
ollama --version
```

Each command should show a version number. If Windows says a command is not recognized, install that program from the **What you need** section, close PowerShell, and open it again.

### Install the project files

Install the project dependencies.

```powershell
npm install
```

Download and check the local voice files. This can take a while on the first run because it downloads the Whisper and Kokoro models.

```powershell
npm run prebuild
```

The wake word and Vulkan files are already included in the repository. The setup command checks their file integrity before Orbit starts or creates a build.

The first setup downloads large local files and may take several minutes. Let it finish even if the progress appears slow. You only need to download valid files once.

## Set up Ollama

Install and open Ollama, then download the model used by Orbit.

```powershell
ollama pull qwen3.5:9b-q4_K_M
```

Orbit connects to Ollama at `http://localhost:11434`. When the Ollama desktop app is installed in its normal Windows location, Orbit will try to start it automatically.

Orbit also supports local screen awareness. If you want to use it, download the optional vision model:

```powershell
ollama pull qwen3-vl:4b
```

The vision model is not required for ordinary conversation or basic voice commands.

## Run Orbit

Start the development version with:

```powershell
npm run dev
```

Keep the PowerShell window open while using the development version. Closing it will also close the running development process.

## Use the Orbit wake up call

When Orbit opens for the first time:

1. Allow microphone access if Windows asks for permission.

2. Press **Enable Orbit**.

3. Wait while Orbit prepares the microphone and checks Ollama.

4. Look for the ready message that says Orbit is waiting for the wake word.

5. Say **Orbit** and then your command in the same sentence.

6. Speak normally and clearly. Orbit will show the words it heard, process the request, and speak its answer.

For example, you can say:

| What you say | What Orbit should try to do |
| --- | --- |
| `Orbit, what time is it?` | Tell you the current time |
| `Orbit, open Spotify` | Find and open Spotify |
| `Orbit, play my music` | Use the supported music controls |
| `Orbit, search YouTube for relaxing music` | Open YouTube search results |
| `Orbit, explain what RAM does` | Answer with the local Ollama model |

You do not need to click the microphone every time after Orbit is enabled. It continues waiting locally for the word **Orbit**. Say the wake word again before every new voice request.

If Orbit misses the wake word, wait a moment and repeat it clearly. The default hybrid mode uses the regular wake word detector and a local Whisper fallback. You can test this from the wake word section in Settings.

Press **Disable Orbit** whenever you want microphone listening to stop. You can also type a request into the conversation box if voice input is not working.

The Settings page includes microphone, wake word, Ollama, speech, browser, and security checks. Run those checks first if voice commands are not working.

## First checks to run

After installation, it is a good idea to open Settings and check each part separately.

1. Use the Ollama test to confirm that the main model is available.

2. Use the microphone test and speak a short sentence.

3. Use the wake word test and say **Orbit** during the listening window.

4. Test the Kokoro voice and adjust its volume or speaking rate.

5. Set a four digit security PIN if you want to try protected file or installer actions.

6. Set up the Chrome extension only if you want page control.

## Create the Windows installer

Run:

```powershell
npm run build:win
```

The build checks TypeScript, prepares the required local models, and creates both an installer and a portable Windows build. Finished files are placed in the `dist` folder.

Windows SmartScreen may warn about the app because personal builds are not code signed.

## Optional Chrome browser control

Orbit can control supported actions on regular web pages through its included Chrome extension.

1. Open `chrome://extensions` in Chrome.

2. Turn on **Developer mode**.

3. Choose **Load unpacked**.

4. Select the extension folder shown in Orbit under **Chrome browser connection**.

5. In Orbit, choose **Begin pairing**.

6. Enter the displayed port and one time code in the extension.

7. Set the extension site access to **On all sites** if Chrome asks.

Browser control is optional. Orbit can still open websites and handle other local commands without the extension.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Opens Orbit in development mode |
| `npm run start` | Opens the already built application |
| `npm run test` | Runs the automated tests |
| `npm run lint` | Checks the code style |
| `npm run typecheck` | Checks the TypeScript code |
| `npm run build` | Creates the application files without packaging them |
| `npm run build:win` | Creates the Windows installer and portable build |
| `npm run build:unpack` | Creates an unpacked Windows application for testing |
| `npm run prebuild` | Downloads and verifies all local runtime files |

## Common problems

### Orbit cannot connect to Ollama

Open the Ollama desktop app and try again. You can also check it from PowerShell.

```powershell
ollama list
```

If the Orbit model is missing, download it again.

```powershell
ollama pull qwen3.5:9b-q4_K_M
```

### Voice setup fails

Run the local file setup again.

```powershell
npm run prebuild
```

Make sure the command finishes without a checksum or download error. Also check that Windows microphone access is enabled for desktop apps.

### The microphone is not detected

Open Windows **Settings**, go to **Privacy & security**, then **Microphone**. Allow microphone access and allow desktop apps to use it. Restart Orbit after changing the permission.

### The Chrome extension does not connect

Keep Orbit open, reload the extension from `chrome://extensions`, then use **Retry connection** in Orbit. If pairing was cleared on either side, forget the old pairing and create a new one.

## Privacy and safety

Orbit is local first. Voice recordings are used for local transcription and temporary audio is removed after processing when possible. The application does not need a cloud account for normal use.

Computer actions go through registered capabilities with validated inputs. Important actions ask for confirmation. Protected file and installer actions require a four digit security PIN. Orbit does not give the language model direct access to PowerShell, Command Prompt, arbitrary scripts, or unrestricted system commands.

## Project stack

Orbit uses Electron, React, TypeScript, electron vite, Ollama, whisper.cpp, sherpa onnx, and Kokoro. Windows packages are created with electron builder.
