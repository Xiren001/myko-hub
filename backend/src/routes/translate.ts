import { Router, Response } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

interface CorrectionSnippet {
  id: string
  location: string | null
  original_text: string | null
  corrected_text: string | null
  issue_type: string | null
  notes: string | null
}

// POST /api/translate
// Body: { corrections: CorrectionSnippet[], language: 'ES' | 'DE' }
// Returns: { translations: CorrectionSnippet[] }
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { corrections, language } = req.body as {
    corrections: CorrectionSnippet[]
    language: string
  }

  if (!corrections?.length) return res.json({ translations: [] })

  const langName = language === 'DE' ? 'German' : 'Spanish'

  try {
    const client = new Anthropic()

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are a professional translator. Translate the following proofreading correction data from ${langName} to English.

Return ONLY a valid JSON array — no markdown, no explanation. Keep the same structure and keep "id" unchanged. Translate: location, original_text, corrected_text, issue_type, notes. Leave null values as null.

${JSON.stringify(corrections)}`,
        },
      ],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]'
    // Strip any markdown code fences Claude might add
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const translations: CorrectionSnippet[] = JSON.parse(cleaned)

    res.json({ translations })
  } catch (err) {
    console.error('Translation error:', err)
    res.status(500).json({ error: 'Translation failed' })
  }
})

export default router
