/* eslint-disable @typescript-eslint/explicit-function-return-type */
class OrbitWakeWordProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunk = new Float32Array(1600)
    this.offset = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    let sourceOffset = 0
    while (sourceOffset < channel.length) {
      const count = Math.min(channel.length - sourceOffset, this.chunk.length - this.offset)
      this.chunk.set(channel.subarray(sourceOffset, sourceOffset + count), this.offset)
      this.offset += count
      sourceOffset += count
      if (this.offset === this.chunk.length) {
        const ready = this.chunk
        this.port.postMessage(ready, [ready.buffer])
        this.chunk = new Float32Array(1600)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('orbit-wake-word-processor', OrbitWakeWordProcessor)
