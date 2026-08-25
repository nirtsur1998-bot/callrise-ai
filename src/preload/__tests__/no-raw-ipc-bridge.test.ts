// The preload's first test, and it exists to pin an ABSENCE.
//
// `contextBridge.exposeInMainWorld('electron', electronAPI)` is electron-vite
// scaffold boilerplate. It hands the renderer @electron-toolkit/preload's raw
// `ipcRenderer`, whose every method — invoke, send, sendSync, postMessage, on,
// once, removeAllListeners — takes the CHANNEL NAME AS A FREE PARAMETER. With
// it exposed, the carefully curated `api` object below it is advisory: anything
// running in the renderer reaches every ipcMain.handle and ipcMain.on channel in
// the app, plus `process.env`, which holds the user's AI API keys.
//
// It was removed because its only consumer was renderer/lib/platform.ts reading
// `window.electron.process.platform`, and `api.platform` is the same value.
//
// WHY A TEST AND NOT JUST A COMMENT. Restoring that line is a one-line change
// that breaks nothing, typechecks clean, and passes every other test in this
// repo — the classic shape where a security property silently regresses. There
// was no test on src/preload at all before this file.
//
// WHY THE AST AND NOT `src.includes(...)`. Taxonomy species 2: a source scan
// cannot tell code from prose, and this very file — plus the long doc comment
// in preload/index.ts explaining the removal — contains the exact string
// `exposeInMainWorld('electron'`. A text match would fail on the comments that
// exist to prevent the bug. Parsing means only real calls count.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts')

/** Every `exposeInMainWorld(<literal>, …)` name actually CALLED in the file. */
function exposedGlobals(): string[] {
  const src = ts.createSourceFile(
    preloadPath,
    readFileSync(preloadPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      names.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return names
}

/** Every `window.<name> = …` assignment (the non-contextIsolated fallback). */
function windowAssignments(): string[] {
  const src = ts.createSourceFile(
    preloadPath,
    readFileSync(preloadPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === 'window'
    ) {
      names.push(node.left.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return names
}

describe('the preload exposes only the narrow api bridge', () => {
  it('never exposes the raw electronAPI / ipcRenderer bridge', () => {
    const exposed = exposedGlobals()

    // Assert the collection is non-empty BEFORE asserting a property over it.
    // Without this, a parser change or a refactor that finds nothing would make
    // every assertion below trivially true — species 6, the vacuous quantifier.
    expect(exposed.length).toBeGreaterThan(0)

    expect(exposed).not.toContain('electron')
    // Pinned exactly rather than as a denylist: a NEW wide bridge under some
    // other name would slip past `not.toContain('electron')`.
    expect(exposed).toEqual(['api'])
  })

  it('never assigns a raw bridge onto window in the non-isolated fallback', () => {
    const assigned = windowAssignments()

    expect(assigned.length).toBeGreaterThan(0)
    expect(assigned).not.toContain('electron')
    expect(assigned).toEqual(['api'])
  })

  it('does not import electronAPI at all, so it cannot be exposed by accident', () => {
    const src = ts.createSourceFile(
      preloadPath,
      readFileSync(preloadPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const imported: string[] = []
    src.forEachChild((node) => {
      if (!ts.isImportDeclaration(node)) return
      const clause = node.importClause
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return
      for (const el of clause.namedBindings.elements) imported.push(el.name.text)
    })

    expect(imported.length).toBeGreaterThan(0) // the file does import things
    expect(imported).not.toContain('electronAPI')
  })
})
