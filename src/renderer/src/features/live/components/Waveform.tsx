import { useEffect, useRef } from 'react'

interface WaveformProps {
  analyser: AnalyserNode | null
  active: boolean
}

/** Live time-domain waveform drawn from the mic's analyser node. */
export function Waveform({ analyser, active }: WaveformProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    }
    resize()

    const data = analyser ? new Uint8Array(analyser.fftSize) : null
    let raf = 0

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      ctx.lineWidth = 2 * dpr
      ctx.lineJoin = 'round'
      ctx.strokeStyle = active ? '#6e7bf2' : '#2a313b'
      ctx.beginPath()
      if (analyser && data) {
        analyser.getByteTimeDomainData(data)
        const slice = w / data.length
        for (let i = 0; i < data.length; i++) {
          const v = data[i] / 128 - 1
          const y = h / 2 + v * (h / 2) * 0.85
          const x = i * slice
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
      } else {
        ctx.moveTo(0, h / 2)
        ctx.lineTo(w, h / 2)
      }
      ctx.stroke()
    }
    draw()

    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [analyser, active])

  return <canvas ref={canvasRef} className="h-14 w-full" />
}
