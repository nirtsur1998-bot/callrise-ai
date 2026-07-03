import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createTask,
  listTasks,
  updateTask,
  deleteTask,
  type Task,
  type TaskCreateInput,
  type TaskUpdateInput
} from './tasks-fs'
import { getCall } from './calls-fs'
import { generateTasks, type GenerateTasksResult } from './generate-tasks'

function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

/** Build the text we send to Claude: the summary (if any) plus the transcript. */
function buildCallText(summaryAndTranscript: {
  summary?: { executive: string; keyPoints: string[]; actionItems: string[] }
  segments: { speaker: number; text: string }[]
}): string {
  const parts: string[] = []
  const { summary, segments } = summaryAndTranscript
  if (summary) {
    if (summary.executive) parts.push(`SUMMARY:\n${summary.executive}`)
    if (summary.keyPoints.length) {
      parts.push(`KEY POINTS:\n${summary.keyPoints.map((p) => `- ${p}`).join('\n')}`)
    }
    if (summary.actionItems.length) {
      parts.push(`ACTION ITEMS NOTED:\n${summary.actionItems.map((p) => `- ${p}`).join('\n')}`)
    }
  }
  parts.push(
    `TRANSCRIPT:\n${segments.map((s) => `Speaker ${s.speaker + 1}: ${s.text}`).join('\n')}`
  )
  return parts.join('\n\n')
}

let registered = false

export function registerTasks(): void {
  if (registered) return
  registered = true

  ipcMain.handle('tasks:list', (): Promise<Task[]> => listTasks(tasksDir()))
  ipcMain.handle('tasks:create', (_event, input: TaskCreateInput) => createTask(tasksDir(), input))
  ipcMain.handle('tasks:update', (_event, id: string, patch: TaskUpdateInput) =>
    updateTask(tasksDir(), id, patch)
  )
  ipcMain.handle('tasks:delete', (_event, id: string) => deleteTask(tasksDir(), id))

  // Ask Claude for suggested tasks from a saved call. Returns proposals only —
  // nothing is saved until the user reviews and accepts them via tasks:create.
  ipcMain.handle(
    'tasks:generateFromCall',
    async (_event, callId: string): Promise<GenerateTasksResult> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
        if (!call.segments?.length) {
          return {
            ok: false,
            error: 'failed',
            message: 'This call has no transcript to generate tasks from.'
          }
        }
        const text = buildCallText({ summary: call.summary, segments: call.segments })
        return await generateTasks(text)
      } catch {
        return { ok: false, error: 'failed', message: 'Something went wrong. Please try again.' }
      }
    }
  )
}
