import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

// Darwin's spawnp can fork once per unsuccessful PATH candidate.
export function probeExecutable(name: 'tmux' | 'ps' | 'remindctl'): string {
  if (process.platform !== 'darwin') return name
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const path = resolve(directory, name)
    try {
      if (!statSync(path).isFile()) continue
      accessSync(path, constants.X_OK)
      return path
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ENOTDIR') throw error
    }
  }
  return name
}
