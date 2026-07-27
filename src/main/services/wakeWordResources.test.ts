import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const resourceRoot = join(process.cwd(), 'resources', 'wake-word')

describe('Orbit wake-word resources', () => {
  it('uses the checksum-pinned 2025 model and officially generated Orbit phonemes', async () => {
    const manifest = JSON.parse(
      await readFile(join(resourceRoot, 'model-manifest.json'), 'utf8')
    ) as Record<string, unknown>
    const keyword = await readFile(join(resourceRoot, 'keywords.txt'), 'utf8')
    const rawKeyword = await readFile(join(resourceRoot, 'keywords.raw.txt'), 'utf8')

    expect(manifest.model).toBe('sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20')
    expect(manifest.archiveSha256).toBe(
      '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'
    )
    expect(rawKeyword.trim()).toBe('ORBIT :1.8 #0.22 @ORBIT')
    expect(keyword.trim()).toBe('AO1 R B AH0 T :1.8 #0.22 @ORBIT')
  })
})
