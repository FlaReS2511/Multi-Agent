// lineDiff.ts — a small LCS-based line differ for the review card. Produces a
// unified row list: context / add / del, each with old/new line numbers where
// applicable. Kept dependency-free and O(n·m) which is fine for single-file
// changes (Monaco/diff libs would be overkill here).

export type DiffKind = 'context' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  text: string
  oldNo?: number  // 1-based line number in the "before" text
  newNo?: number  // 1-based line number in the "after" text
}

// Above this many table cells the exact LCS is skipped and the whole changed
// middle is reported as one del/add block — bounded time and memory instead of
// an O(n·m) matrix that could hit hundreds of MB on a full-file replacement.
const LCS_MAX_CELLS = 4_000_000

export function computeLineDiff(before: string, after: string): DiffRow[] {
  // Strip a single trailing newline so a final "\n" doesn't show as a blank row.
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n')

  // Edits are local: peel the common prefix/suffix first so the O(n·m) LCS
  // table only covers the changed middle, not the whole file.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++

  const rows: DiffRow[] = []
  for (let k = 0; k < pre; k++) rows.push({ kind: 'context', text: a[k], oldNo: k + 1, newNo: k + 1 })

  const n = a.length - pre - suf
  const m = b.length - pre - suf
  const oldAt = (i: number) => pre + i + 1
  const newAt = (j: number) => pre + j + 1

  if (n > 0 && m > 0 && n * m > LCS_MAX_CELLS) {
    // Too big for an exact diff — report the middle as replaced wholesale.
    for (let i = 0; i < n; i++) rows.push({ kind: 'del', text: a[pre + i], oldNo: oldAt(i) })
    for (let j = 0; j < m; j++) rows.push({ kind: 'add', text: b[pre + j], newNo: newAt(j) })
  } else {
    // LCS length table over the middle only.
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[pre + i] === b[pre + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[pre + i] === b[pre + j]) {
        rows.push({ kind: 'context', text: a[pre + i], oldNo: oldAt(i), newNo: newAt(j) })
        i++; j++
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        rows.push({ kind: 'del', text: a[pre + i], oldNo: oldAt(i) })
        i++
      } else {
        rows.push({ kind: 'add', text: b[pre + j], newNo: newAt(j) })
        j++
      }
    }
    while (i < n) { rows.push({ kind: 'del', text: a[pre + i], oldNo: oldAt(i) }); i++ }
    while (j < m) { rows.push({ kind: 'add', text: b[pre + j], newNo: newAt(j) }); j++ }
  }

  for (let k = 0; k < suf; k++) {
    rows.push({
      kind: 'context',
      text: a[a.length - suf + k],
      oldNo: a.length - suf + k + 1,
      newNo: b.length - suf + k + 1,
    })
  }
  return rows
}
