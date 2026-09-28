import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { WordCloud } from '@isoterik/react-word-cloud'
import { BRIEF_REF_5190_MAX_BYTES } from './constants'

const ALLOWED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.webm',
  '.flac',
]

const WORD_CLOUD_WIDTH = 640
const WORD_CLOUD_HEIGHT = 384
const WORD_CLOUD_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

function resolveWordFontSize(word) {
  const weight = Math.max(1, Math.min(10, Number(word.value) || 1))
  return Math.round(11 + weight * 1.9)
}

function resolveWordFontWeight(word) {
  const weight = Number(word.value) || 1
  if (weight >= 7) return '700'
  if (weight >= 4) return '600'
  return '500'
}

function resolveWordRotate() {
  return 0
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getUnsupportedMessage() {
  if (!window.isSecureContext) {
    return 'Microphone recording needs a secure page. Open this app on localhost or HTTPS, then try Record Audio again.'
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot access the microphone. Try Chrome, Edge, or Safari, then tap Record Audio again.'
  }
  if (typeof MediaRecorder === 'undefined') {
    return 'This browser cannot record audio. Try Chrome, Edge, or Safari, then tap Record Audio again.'
  }
  return null
}

function pickMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

function messageForError(error) {
  const name = error?.name

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone access was denied. Allow the microphone in your browser settings, then tap Record Audio again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect a microphone, then tap Record Audio again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is being used by another app. Close that app, then tap Record Audio again.'
  }
  if (name === 'SecurityError') {
    return 'Microphone recording needs a secure page. Open this app on localhost or HTTPS, then try Record Audio again.'
  }

  return 'Could not start recording. Check your microphone, then tap Record Audio again.'
}

function App() {
  const [isRecording, setIsRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [topics, setTopics] = useState([])
  const [transcript, setTranscript] = useState('')
  const [recordedFile, setRecordedFile] = useState(null)
  const [selectedFileDuration, setSelectedFileDuration] = useState(null)

  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const startedAtRef = useRef(0)
  const wordCloudRef = useRef(null)

  const cloudWords = useMemo(
    () =>
      topics.map((topic) => ({
        text: String(topic.term || '').trim(),
        value: Number(topic.weight) || 1,
      })),
    [topics]
  )

  function clearTimer() {
    if (timerRef.current != null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  function releaseMicrophone() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  function downloadWordCloud() {
    const svg = wordCloudRef.current?.querySelector('svg')

    if (!svg) {
      setError('There is no word cloud to download yet.')
      return
    }

    const exportWidth = svg.clientWidth || WORD_CLOUD_WIDTH
    const exportHeight = svg.clientHeight || WORD_CLOUD_HEIGHT

    const clonedSvg = svg.cloneNode(true)
    clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clonedSvg.setAttribute('width', String(exportWidth))
    clonedSvg.setAttribute('height', String(exportHeight))

    const serializer = new XMLSerializer()
    const svgString = serializer.serializeToString(clonedSvg)
    const svgBlob = new Blob([svgString], {
      type: 'image/svg+xml;charset=utf-8',
    })

    const url = URL.createObjectURL(svgBlob)
    const image = new Image()

    image.onload = () => {
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = exportWidth * scale
      canvas.height = exportHeight * scale

      const context = canvas.getContext('2d')
      context.scale(scale, scale)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, exportWidth, exportHeight)
      context.drawImage(image, 0, 0, exportWidth, exportHeight)

      canvas.toBlob((blob) => {
        if (!blob) {
          setError('Could not create the PNG download.')
          URL.revokeObjectURL(url)
          return
        }

        const downloadUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = downloadUrl
        link.download = 'insight-word-cloud.png'
        link.click()

        URL.revokeObjectURL(downloadUrl)
        URL.revokeObjectURL(url)
      }, 'image/png')
    }

    image.onerror = () => {
      URL.revokeObjectURL(url)
      setError('Could not create the PNG download.')
    }

    image.src = url
  }

  async function startRecording() {
    setError('')
    setTopics([])

    const unsupported = getUnsupportedMessage()
    if (unsupported) {
      setError(unsupported)
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = pickMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      recorder.onerror = () => {
        clearTimer()
        releaseMicrophone()
        mediaRecorderRef.current = null
        setIsRecording(false)
        setError('Recording stopped unexpectedly. Tap Record Audio to try again.')
      }

      mediaRecorderRef.current = recorder

const chunks = []

recorder.ondataavailable = (event) => {
  if (event.data.size > 0) {
    chunks.push(event.data)
  }
}

recorder.onstop = () => {
  const blob = new Blob(chunks, {
    type: recorder.mimeType || 'audio/webm',
  })

  const url = URL.createObjectURL(blob)
  setAudioUrl(url)

  const file = new File(
    [blob],
    'insight-recording.webm',
    { type: blob.type }
  )
  
  if (file.size > BRIEF_REF_5190_MAX_BYTES) {
    setError('This recording is too large. Please keep recordings under 25 MB.')
    setRecordedFile(null)
    return
  }
  
  setRecordedFile(file)
  analyzeAudio(file)
}
recorder.start()
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setIsRecording(true)

      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current
        setElapsedMs(elapsed)
      
        if (elapsed >= 10 * 60 * 1000) {
          setError('Recording reached the 10-minute limit.')
          recorder.stop()
          clearTimer()
        }
      }, 200)
    } catch (error) {
      releaseMicrophone()
      setIsRecording(false)
      setError(messageForError(error))
    }
  }
  async function analyzeAudio(file) {
    console.log('analyzeAudio called', file)
    setError('')
    setIsAnalyzing(true)
  
    try {
      const formData = new FormData()
      formData.append('audio', file)
  
      const response = await fetch('https://session-word-cloud.onrender.com/api/analyze', {
        method: 'POST',
        body: formData,
      })
  
      const data = await response.json()
  
      if (!response.ok) {
        throw new Error(data.error || 'Audio analysis failed.')
      }
      console.log('RAW GEMINI RESULT:', data.result)
      const cleaned = data.result
  .replace(/```json/g, '')
  .replace(/```/g, '')
  .trim()

const parsed = JSON.parse(cleaned)
console.log('GEMINI PARSED:', parsed)

if (parsed.status === 'no_speech') {
  setTopics([])
  setTranscript('')
  setError('No meaningful speech was detected in this audio.')
  return
}

setTranscript(parsed.transcript || '')
setTopics(parsed.topics || [])
    } catch (error) {
      console.error(error)
      setError(error.message || 'Audio analysis failed.')
    } finally {
      setIsAnalyzing(false)
    }
  }
  function stopRecording() {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }

    clearTimer()
    releaseMicrophone()
    mediaRecorderRef.current = null
    setIsRecording(false)
  }

  useEffect(() => {
    return () => {
      clearTimer()
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      releaseMicrophone()
    }
  }, [])

  return (
    <main className="app">
      <header className="header">
        <h1>Insight</h1>
        <p className="instruction">
          Record or upload audio to see the main topics at a glance.
        </p>
      </header>

      {isRecording ? (
        <div className="recording-status" role="status" aria-live="polite">
          <span className="recording-dot" aria-hidden="true" />
          <span>Recording</span>
          <span className="timer">{formatElapsed(elapsedMs)}</span>
        </div>
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="actions">
        {isRecording ? (
          <button type="button" className="btn btn-stop" onClick={stopRecording}>
            Stop Recording
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={startRecording}>
            Record Audio
          </button>
        )}
        <label className="btn btn-secondary">
  Upload Audio
  <input
  type="file"
  accept=".mp3,.wav,.m4a,.aac,.ogg,.webm,.flac"
  hidden
  onChange={(event) => {
    const file = event.target.files?.[0]
    if (file) 
      {
        const extension = `.${file.name.split('.').pop().toLowerCase()}`

if (!ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
  setError(
    'Unsupported audio format. Please choose an MP3, WAV, M4A, AAC, OGG, WEBM, or FLAC file.'
  )
  return
}

setError('')
if (file.size > BRIEF_REF_5190_MAX_BYTES) {
  setError('This audio file is too large. Please choose a file up to 25 MB.')
  return
}
      setSelectedFile(file)
      
    
      const url = URL.createObjectURL(file)
const audio = document.createElement('audio')

audio.preload = 'metadata'

audio.onloadedmetadata = () => {
  if (audio.duration > 10 * 60) {
    setError('This audio is too long. Please choose a file that is 10 minutes or shorter.')
    setSelectedFileDuration(null)
    URL.revokeObjectURL(url)
    return
  }

  setError('')
  setSelectedFileDuration(audio.duration)
  URL.revokeObjectURL(url)
  analyzeAudio(file)
}

audio.onerror = () => {
  setSelectedFileDuration(null)
  URL.revokeObjectURL(url)
  setError('Could not read this audio file. Please try a different file.')
}
audio.src = url
    }
  }}
/>
</label>
      </div>
      <div className="actions">
  {/* your existing buttons */}
</div>

{audioUrl ? (
  <section className="recording-preview">
    <p>Recording preview</p>
    <audio controls src={audioUrl} />
    <div className="recording-actions">
  <button
    type="button"
    className="btn btn-secondary"
    onClick={() => analyzeAudio(recordedFile)}
    disabled={!recordedFile || isAnalyzing}
  >
    ↻ Analyze Again
  </button>

  <a
    className="btn btn-secondary"
    href={audioUrl}
    download="insight-recording.webm"
  >
    Download Recording
  </a>
</div>
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => {
        URL.revokeObjectURL(audioUrl)
        setAudioUrl('')
        setTopics([])
        setSelectedFile(null)
        setRecordedFile(null)
        setSelectedFileDuration(null)
        setError('')
      }}
    >
      Discard & Record Again
    </button>
  </section>
) : null}
{selectedFile ? (
  <p className="selected-file">
    Selected file: {selectedFile.name} · {formatFileSize(selectedFile.size)}
    {selectedFileDuration !== null
      ? ` · ${Math.floor(selectedFileDuration / 60)}:${String(Math.floor(selectedFileDuration % 60)).padStart(2, '0')}`
      : ''}
  </p>
) : null}
{transcript ? (
  <section className="transcript-section" aria-label="Transcript">
    <h2>Transcript</h2>
    <p>{transcript}</p>
  </section>
) : null}
<section className="word-cloud-area" aria-label="Word cloud">
  {isAnalyzing ? (
    <div className="analysis-status" role="status" aria-live="polite">
      <p className="analysis-title">Analyzing your audio…</p>
      <p className="analysis-subtitle">
        This may take a moment.
      </p>
    </div>
  ) : cloudWords.length > 0 ? (
    <div className="word-cloud-result">
      <div
        className="word-cloud"
        ref={wordCloudRef}
        style={{ width: '100%', height: '352px' }}
      >
        <WordCloud
          words={cloudWords}
          width={WORD_CLOUD_WIDTH}
          height={WORD_CLOUD_HEIGHT}
          font={WORD_CLOUD_FONT}
          fontSize={resolveWordFontSize}
          fontWeight={resolveWordFontWeight}
          rotate={resolveWordRotate}
          padding={4}
          spiral="archimedean"
          svgProps={{
            width: '100%',
            height: '100%',
            preserveAspectRatio: 'xMidYMid meet',
          }}
        />
      </div>

      <button
        type="button"
        className="btn btn-secondary"
        onClick={downloadWordCloud}
      >
        Download Word Cloud
      </button>
    </div>
  ) : (
    <p className="placeholder">Your word cloud will appear here.</p>
  )}
</section>
    </main>
  )
}

export default App
