export type WakeWordWorkerResources = {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  keywords: string
}

export type WakeWordWorkerInput =
  | { type: 'initialize'; resources: WakeWordWorkerResources }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'shutdown' }

export type WakeWordWorkerOutput =
  | { type: 'ready' }
  | { type: 'state'; state: 'detected' | 'capturing' | 'paused' | 'armed' }
  | { type: 'command'; samples: Float32Array }
  | { type: 'error'; message: string }
