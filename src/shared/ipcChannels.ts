export const IPC_CHANNELS = {
  assistantAsk: 'orbit:assistant:ask',
  assistantCancel: 'orbit:assistant:cancel',
  wakeWordStart: 'orbit:wake-word:start',
  wakeWordStop: 'orbit:wake-word:stop',
  wakeWordPause: 'orbit:wake-word:pause',
  wakeWordResume: 'orbit:wake-word:resume',
  wakeWordTestStart: 'orbit:wake-word:test-start',
  wakeWordTestCancel: 'orbit:wake-word:test-cancel',
  wakeWordAudioChunk: 'orbit:wake-word:audio-chunk',
  wakeWordEvent: 'orbit:wake-word:event',
  microphoneTestTranscribe: 'orbit:microphone-test:transcribe',
  microphoneTestCancel: 'orbit:microphone-test:cancel',
  ollamaHealth: 'orbit:ollama:health',
  settingsGet: 'orbit:settings:get',
  settingsUpdate: 'orbit:settings:update',
  actionExecute: 'orbit:action:execute',
  actionConfirm: 'orbit:action:confirm'
} as const
