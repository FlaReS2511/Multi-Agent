// OrqonLogo.tsx — the Orqon hexagon neon logo as a reusable component.

import type { CSSProperties } from 'react'

interface Props {
  size?: number
  className?: string
  style?: CSSProperties
  /** Flat single-tone watermark variant (uses currentColor, no neon glow). */
  mono?: boolean
}

export function OrqonLogo({ size = 22, className, style, mono = false }: Props) {
  // Unique filter id per instance so multiple logos don't clash in the DOM.
  const fid = 'orqon-glow'

  if (mono) {
    // Debossed watermark: everything in currentColor, no fills, no glow.
    // Caller controls tone/opacity via text color + opacity classes.
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className={className}
        style={style}
        fill="none"
        stroke="currentColor"
      >
        <polygon
          points="50,7 87.3,28.5 87.3,71.5 50,93 12.7,71.5 12.7,28.5"
          strokeWidth="1.5"
          strokeDasharray="3 3"
          opacity="0.5"
        />
        <g strokeWidth="1.5" opacity="0.4">
          <line x1="50" y1="50" x2="50" y2="15" />
          <line x1="50" y1="50" x2="50" y2="85" />
          <line x1="50" y1="50" x2="19.7" y2="32.5" />
          <line x1="50" y1="50" x2="80.3" y2="32.5" />
          <line x1="50" y1="50" x2="19.7" y2="67.5" />
          <line x1="50" y1="50" x2="80.3" y2="67.5" />
        </g>
        <polygon
          points="50,15 80.3,32.5 80.3,67.5 50,85 19.7,67.5 19.7,32.5"
          strokeWidth="3.75"
        />
        <g strokeWidth="2.25">
          <circle cx="50" cy="15" r="4.5" />
          <circle cx="80.3" cy="32.5" r="4.5" />
          <circle cx="80.3" cy="67.5" r="4.5" />
          <circle cx="50" cy="85" r="4.5" />
          <circle cx="19.7" cy="67.5" r="4.5" />
          <circle cx="19.7" cy="32.5" r="4.5" />
        </g>
        <polygon
          points="50,38 60.4,44 60.4,56 50,62 39.6,56 39.6,44"
          strokeWidth="2.25"
          opacity="0.9"
        />
      </svg>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={style}
    >
      <defs>
        <filter id={fid} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <polygon
        points="50,7 87.3,28.5 87.3,71.5 50,93 12.7,71.5 12.7,28.5"
        fill="none"
        stroke="#1b3a32"
        strokeWidth="1"
        strokeDasharray="3 3"
      />

      <g stroke="#00FFCC" strokeWidth="1" opacity="0.3">
        <line x1="50" y1="50" x2="50" y2="15" />
        <line x1="50" y1="50" x2="50" y2="85" />
        <line x1="50" y1="50" x2="19.7" y2="32.5" />
        <line x1="50" y1="50" x2="80.3" y2="32.5" />
        <line x1="50" y1="50" x2="19.7" y2="67.5" />
        <line x1="50" y1="50" x2="80.3" y2="67.5" />
      </g>

      <polygon
        points="50,15 80.3,32.5 80.3,67.5 50,85 19.7,67.5 19.7,32.5"
        fill="#0A1210"
        stroke="#00FFCC"
        strokeWidth="2.5"
        filter={`url(#${fid})`}
      />

      <g filter={`url(#${fid})`}>
        <circle cx="50" cy="15" r="4.5" fill="#00FFCC" />
        <circle cx="80.3" cy="32.5" r="4.5" fill="#00FFCC" />
        <circle cx="80.3" cy="67.5" r="4.5" fill="#00FFCC" />
        <circle cx="50" cy="85" r="4.5" fill="#00FFCC" />
        <circle cx="19.7" cy="67.5" r="4.5" fill="#00FFCC" />
        <circle cx="19.7" cy="32.5" r="4.5" fill="#00FFCC" />
      </g>
      <g fill="#0A1210">
        <circle cx="50" cy="15" r="1.5" />
        <circle cx="80.3" cy="32.5" r="1.5" />
        <circle cx="80.3" cy="67.5" r="1.5" />
        <circle cx="50" cy="85" r="1.5" />
        <circle cx="19.7" cy="67.5" r="1.5" />
        <circle cx="19.7" cy="32.5" r="1.5" />
      </g>

      <polygon
        points="50,38 60.4,44 60.4,56 50,62 39.6,56 39.6,44"
        fill="#00FFCC"
        opacity="0.8"
      />
      <circle cx="50" cy="50" r="2.5" fill="#0A1210" />
    </svg>
  )
}
