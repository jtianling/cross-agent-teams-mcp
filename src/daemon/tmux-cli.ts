import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

let _isTmuxAvailable: boolean | null = null

export async function isTmuxAvailable(): Promise<boolean> {
  if (_isTmuxAvailable !== null) return _isTmuxAvailable
  try {
    await pExecFile('tmux', ['-V'])
    _isTmuxAvailable = true
  } catch {
    _isTmuxAvailable = false
  }
  return _isTmuxAvailable
}

const TMUX_CAPTURE_TIMEOUT_MS = 5_000

export async function capturePaneTail(paneId: string, lines = 8): Promise<string> {
  const { stdout } = await pExecFile(
    'tmux',
    ['capture-pane', '-t', paneId, '-p', '-S', `-${lines}`],
    { timeout: TMUX_CAPTURE_TIMEOUT_MS }
  )
  return stdout
}

export function loadBuffer(bufferName: string, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['load-buffer', '-b', bufferName, '-'])
    let stderr = ''
    child.on('error', reject)
    if (child.stderr) {
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    }
    child.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`load-buffer exit ${code}: ${stderr}`))
    })
    child.stdin.write(Buffer.from(prompt, 'utf8'))
    child.stdin.end()
  })
}

export async function pasteBuffer(bufferName: string, paneId: string): Promise<void> {
  await pExecFile('tmux', ['paste-buffer', '-b', bufferName, '-t', paneId, '-p', '-d'])
}

export async function sendEnter(paneId: string): Promise<void> {
  await pExecFile('tmux', ['send-keys', '-t', paneId, 'Enter'])
}

export async function deleteBuffer(bufferName: string): Promise<void> {
  await pExecFile('tmux', ['delete-buffer', '-b', bufferName])
}

export function _resetTmuxAvailableCache(): void {
  _isTmuxAvailable = null
}

export function _setTmuxAvailableForTest(value: boolean): void {
  _isTmuxAvailable = value
}
