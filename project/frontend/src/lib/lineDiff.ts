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

export function computeLineDiff(before: string, after: string): DiffRow[] {
  // Strip a single trailing newline so a final "\n" doesn't show as a blank row.
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n')

  // LCS length table.
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i], oldNo: i + 1 })
      i++
    } else {
      rows.push({ kind: 'add', text: b[j], newNo: j + 1 })
      j++
    }
  }
  while (i < n) { rows.push({ kind: 'del', text: a[i], oldNo: i + 1 }); i++ }
  while (j < m) { rows.push({ kind: 'add', text: b[j], newNo: j + 1 }); j++ }
  return rows
}
