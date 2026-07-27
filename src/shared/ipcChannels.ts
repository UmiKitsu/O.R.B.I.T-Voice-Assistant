export const IPC_CHANNELS = {
  assistantAsk: 'titan:assistant:ask',
  assistantCancel: 'titan:assistant:cancel',
  wakeWordStart: 'titan:wake-word:start',
  wakeWordStop: 'titan:wake-word:stop',
  wakeWordPause: 'titan:wake-word:pause',
  wakeWordResume: 'titan:wake-word:resume',
  wakeWordAudioChunk: 'titan:wake-word:audio-chunk',
  wakeWordEvent: 'titan:wake-word:event',
  ollamaHealth: 'titan:ollama:health',
  settingsGet: 'titan:settings:get',
  settingsUpdate: 'titan:settings:update',
  actionExecute: 'titan:action:execute',
  actionConfirm: 'titan:action:confirm'
} as const
