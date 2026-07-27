import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const resourceRoot = join(process.cwd(), 'resources', 'wake-word')

describe('Orbit wake-word resources', () => {
  it('uses the checksum-pinned 2025 model and officially generated pronunciation variants', async () => {
    const manifest = JSON.parse(
      await readFile(join(resourceRoot, 'model-manifest.json'), 'utf8')
    ) as Record<string, unknown>
    const keyword = await readFile(join(resourceRoot, 'keywords.txt'), 'utf8')
    const rawKeyword = await readFile(join(resourceRoot, 'keywords.raw.txt'), 'utf8')

    expect(manifest.model).toBe('sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20')
    expect(manifest.archiveSha256).toBe(
      '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'
    )
    expect(rawKeyword.trim().split(/\r?\n/)).toEqual([
      'ORBIT :1.8 #0.22 @ORBIT',
      'OR BIT :2.0 #0.18 @OR_BIT'
    ])
    expect(keyword.trim().split(/\r?\n/)).toEqual([
      'AO1 R B AH0 T :1.8 #0.22 @ORBIT',
      'AO1 R B IH1 T :2.0 #0.18 @OR_BIT'
    ])
    expect(manifest.keywordTokenizer).toMatchObject({
      tool: 'sherpa-onnx 1.13.4 text2token',
      tokensType: 'phone+ppinyin',
      keywords: [
        { keyword: 'ORBIT', generatedTokens: 'AO1 R B AH0 T', boost: 1.8, threshold: 0.22 },
        {
          keyword: 'OR BIT',
          canonical: 'ORBIT',
          generatedTokens: 'AO1 R B IH1 T',
          boost: 2,
          threshold: 0.18
        }
      ]
    })
  })
})
