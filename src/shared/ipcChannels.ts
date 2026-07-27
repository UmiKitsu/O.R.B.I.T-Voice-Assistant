export const IPC_CHANNELS = {
  assistantAsk: 'titan:assistant:ask',
  assistantCancel: 'titan:assistant:cancel',
  assistantClear: 'titan:assistant:clear',
  speechTranscribe: 'titan:speech:transcribe',
  speechCancelTranscription: 'titan:speech:cancel-transcription',
  ollamaHealth: 'titan:ollama:health',
  settingsGet: 'titan:settings:get',
  settingsUpdate: 'titan:settings:update',
  actionExecute: 'titan:action:execute',
  actionConfirm: 'titan:action:confirm'
} as const
