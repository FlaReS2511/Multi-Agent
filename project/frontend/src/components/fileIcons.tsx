// fileIcons.tsx — maps a filename to a brand/language icon (react-icons).
//
// Uses Simple Icons (Si*) for real brand logos with their canonical colors, and
// falls back to a couple of Vscode-ish generic icons where no brand fits.

import type { ReactNode } from 'react'
import {
  SiPython,
  SiJavascript,
  SiTypescript,
  SiReact,
  SiHtml5,
  SiCss,
  SiJson,
  SiMarkdown,
  SiGnubash,
  SiYaml,
  SiRust,
  SiGo,
  SiCplusplus,
  SiC,
  SiRuby,
  SiPhp,
  SiSharp,
  SiKotlin,
  SiSwift,
  SiDocker,
  SiToml,
  SiGit,
  SiVite,
  SiTailwindcss,
  SiSass,
  SiGraphql,
  SiLua,
  SiR,
  SiDart,
  SiElixir,
  SiScala,
} from 'react-icons/si'
import { VscJson, VscFile, VscFileMedia, VscTerminal } from 'react-icons/vsc'
import { FaJava, FaDatabase, FaFileArchive, FaFilePdf, FaFont } from 'react-icons/fa'

interface IconDef {
  icon: ReactNode
  color: string
}

// Keyed by lower-case extension (no dot). First match wins.
const EXT_MAP: Record<string, IconDef> = {
  py: { icon: <SiPython />, color: '#3776AB' },
  pyi: { icon: <SiPython />, color: '#3776AB' },
  js: { icon: <SiJavascript />, color: '#F7DF1E' },
  mjs: { icon: <SiJavascript />, color: '#F7DF1E' },
  cjs: { icon: <SiJavascript />, color: '#F7DF1E' },
  jsx: { icon: <SiReact />, color: '#61DAFB' },
  ts: { icon: <SiTypescript />, color: '#3178C6' },
  tsx: { icon: <SiReact />, color: '#61DAFB' },
  html: { icon: <SiHtml5 />, color: '#E34F26' },
  htm: { icon: <SiHtml5 />, color: '#E34F26' },
  css: { icon: <SiCss />, color: '#1572B6' },
  scss: { icon: <SiSass />, color: '#CC6699' },
  sass: { icon: <SiSass />, color: '#CC6699' },
  json: { icon: <SiJson />, color: '#CBCB41' },
  jsonc: { icon: <VscJson />, color: '#CBCB41' },
  md: { icon: <SiMarkdown />, color: '#9CA3AF' },
  markdown: { icon: <SiMarkdown />, color: '#9CA3AF' },
  sh: { icon: <SiGnubash />, color: '#4EAA25' },
  bash: { icon: <SiGnubash />, color: '#4EAA25' },
  zsh: { icon: <SiGnubash />, color: '#4EAA25' },
  yml: { icon: <SiYaml />, color: '#CB171E' },
  yaml: { icon: <SiYaml />, color: '#CB171E' },
  toml: { icon: <SiToml />, color: '#9C4221' },
  rs: { icon: <SiRust />, color: '#DEA584' },
  go: { icon: <SiGo />, color: '#00ADD8' },
  c: { icon: <SiC />, color: '#A8B9CC' },
  h: { icon: <SiC />, color: '#A8B9CC' },
  cpp: { icon: <SiCplusplus />, color: '#00599C' },
  cc: { icon: <SiCplusplus />, color: '#00599C' },
  cxx: { icon: <SiCplusplus />, color: '#00599C' },
  hpp: { icon: <SiCplusplus />, color: '#00599C' },
  cs: { icon: <SiSharp />, color: '#68217A' },
  java: { icon: <FaJava />, color: '#EA2D2E' },
  kt: { icon: <SiKotlin />, color: '#7F52FF' },
  kts: { icon: <SiKotlin />, color: '#7F52FF' },
  swift: { icon: <SiSwift />, color: '#F05138' },
  rb: { icon: <SiRuby />, color: '#CC342D' },
  php: { icon: <SiPhp />, color: '#777BB4' },
  lua: { icon: <SiLua />, color: '#2C2D72' },
  r: { icon: <SiR />, color: '#276DC3' },
  dart: { icon: <SiDart />, color: '#0175C2' },
  ex: { icon: <SiElixir />, color: '#4B275F' },
  exs: { icon: <SiElixir />, color: '#4B275F' },
  scala: { icon: <SiScala />, color: '#DC322F' },
  graphql: { icon: <SiGraphql />, color: '#E10098' },
  gql: { icon: <SiGraphql />, color: '#E10098' },
  sql: { icon: <FaDatabase />, color: '#4479A1' },
  db: { icon: <FaDatabase />, color: '#4479A1' },
  sqlite: { icon: <FaDatabase />, color: '#4479A1' },
  pdf: { icon: <FaFilePdf />, color: '#F40F02' },
  zip: { icon: <FaFileArchive />, color: '#F5A623' },
  tar: { icon: <FaFileArchive />, color: '#F5A623' },
  gz: { icon: <FaFileArchive />, color: '#F5A623' },
  png: { icon: <VscFileMedia />, color: '#26A69A' },
  jpg: { icon: <VscFileMedia />, color: '#26A69A' },
  jpeg: { icon: <VscFileMedia />, color: '#26A69A' },
  gif: { icon: <VscFileMedia />, color: '#26A69A' },
  svg: { icon: <VscFileMedia />, color: '#FFB13B' },
  webp: { icon: <VscFileMedia />, color: '#26A69A' },
  ico: { icon: <VscFileMedia />, color: '#26A69A' },
  ttf: { icon: <FaFont />, color: '#9CA3AF' },
  otf: { icon: <FaFont />, color: '#9CA3AF' },
  woff: { icon: <FaFont />, color: '#9CA3AF' },
  woff2: { icon: <FaFont />, color: '#9CA3AF' },
}

// Keyed by exact lower-case filename (takes priority over extension).
const NAME_MAP: Record<string, IconDef> = {
  dockerfile: { icon: <SiDocker />, color: '#2496ED' },
  '.gitignore': { icon: <SiGit />, color: '#F05032' },
  '.gitattributes': { icon: <SiGit />, color: '#F05032' },
  'vite.config.ts': { icon: <SiVite />, color: '#646CFF' },
  'vite.config.js': { icon: <SiVite />, color: '#646CFF' },
  'tailwind.config.js': { icon: <SiTailwindcss />, color: '#06B6D4' },
  'tailwind.config.ts': { icon: <SiTailwindcss />, color: '#06B6D4' },
}

const DEFAULT: IconDef = { icon: <VscFile />, color: '#9CA3AF' }
const TERMINAL: IconDef = { icon: <VscTerminal />, color: '#4EAA25' }

export function getFileIcon(filename: string): IconDef {
  const lower = filename.toLowerCase()
  if (NAME_MAP[lower]) return NAME_MAP[lower]
  if (lower.endsWith('.bat') || lower.endsWith('.cmd') || lower.endsWith('.ps1')) return TERMINAL
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return EXT_MAP[ext] ?? DEFAULT
}
