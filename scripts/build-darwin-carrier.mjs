import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [directory, arch = process.arch] = process.argv.slice(2)
if (!directory || !['arm64', 'x64'].includes(arch)) {
  throw new Error('Expected output directory and Darwin architecture')
}
mkdirSync(directory, { recursive: true })
execFileSync('/usr/bin/clang++', [
  '-std=c++17', '-O2', '-bundle', '-undefined', 'dynamic_lookup',
  '-arch', arch === 'x64' ? 'x86_64' : arch, '-mmacosx-version-min=11.0',
  '-I', join(dirname(process.execPath), '../include/node'),
  'src/native/carrier-darwin.cc', '-o', join(directory, `carrier-${arch}.node`),
], { stdio: 'inherit' })
