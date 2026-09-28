import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import ai from './gemini.js'
import multer from 'multer'
import fs from 'fs/promises'
import path from 'path'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

const upload = multer({
  storage: multer.memoryStorage(),
})

const tempDir = path.join(process.cwd(), 'server', 'temp')

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
]

async function generateWithRetry(contents, maxAttempts = 2) {
  let lastError

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await ai.models.generateContent({
          model,
          contents,
        })
      } catch (error) {
        lastError = error

        if (error?.status === 429) {
          console.log(
            `Quota reached for ${model} (429). Falling back to next available model...`
          )
          break
        }

        if (error?.status === 503) {
          if (attempt < maxAttempts) {
            const delay = 1500 * 2 ** (attempt - 1)
            console.log(
              `Gemini (${model}) temporarily unavailable. Retrying in ${delay / 1000}s...`
            )
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }

          console.log(
            `Gemini (${model}) still busy (503). Falling back to next available model...`
          )
          break
        }

        throw error
      }
    }
  }

  throw lastError
}

app.post('/api/analyze', upload.single('audio'), async (req, res) => {
  let tempFilePath = ''

  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No audio file was provided.',
      })
    }

    await fs.mkdir(tempDir, { recursive: true })

    const safeFileName = `${Date.now()}-${req.file.originalname}`
    tempFilePath = path.join(tempDir, safeFileName)

    await fs.writeFile(tempFilePath, req.file.buffer)

    const uploadedFile = await ai.files.upload({
      file: tempFilePath,
      config: {
        mimeType: req.file.mimetype,
      },
    })

    const response = await generateWithRetry([
      {
        fileData: {
          fileUri: uploadedFile.uri,
          mimeType: uploadedFile.mimeType,
        },
      },
      {
        text: `
Analyze this audio recording from a one-to-one school mentoring session.

First, determine whether the recording contains meaningful human speech.

If the recording contains no meaningful speech, such as silence, near-silence, or audio that cannot be understood as speech, return:

{
  "status": "no_speech",
  "transcript": "",
  "topics": []
}

If meaningful speech is present, create a clean transcript and identify the main topics.

For the transcript:
- Preserve the meaning and important details of what was said.
- Remove filler words such as "um", "uh", "erm", and unnecessary conversational fillers.
- Remove repeated words, false starts, and meaningless fragments where possible.
- Do not invent or add information that was not spoken.
- If a part is genuinely impossible to understand, omit that fragment.

For the topics:
- Do NOT simply count individual word frequency.
- Focus on concepts that are genuinely prominent or important to the discussion.
- Ignore greetings, filler words, stopwords, generic conversational phrases, and insignificant words.
- Combine obvious variations when appropriate, such as singular/plural forms or closely related phrases.
- Prefer concise topic names rather than full sentences.
- Include around 5 to 15 meaningful topics.
- Give each topic a weight from 1 to 10 based on its prominence.

Return ONLY valid JSON in this exact structure when speech is present:

{
  "status": "success",
  "transcript": "Clean transcript of the meaningful spoken content.",
  "topics": [
    {
      "term": "example topic",
      "weight": 10
    }
  ]
}
`,
      },
    ])

    res.json({
      result: response.text,
    })
  } catch (error) {
    console.error(error)

    res.status(error?.status || 500).json({
        error:
          error?.status === 503
            ? 'The AI service is temporarily busy. Please try again in a moment.'
            : 'Audio analysis failed. Please try again.',
      })
  } finally {
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(() => {})
    }
  }
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})