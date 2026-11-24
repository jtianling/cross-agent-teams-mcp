import { createHmac, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, rmdir, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  readAgyBoundIdentity, requestAgyClaim, requestAgyLauncher,
} from '../src/mcp/antigravity-pty.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: vi.fn(fs.lstat) };
});

const uid = process.getuid!();
const dir = `/tmp/xats-agy-${uid}`;
let createdDir = false;
const cleanup: (() => Promise<void>)[] = [];
const identity = () => ({ launch_id: randomUUID(), name: '助手', team: 'test' });
const socketPath = (id: string) => `${dir}/${id}.sock`;

beforeAll(async () => {
  createdDir = !!await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.uid).toBe(uid);
  expect(stat.mode & 0o077).toBe(0);
});
afterEach(async () => {
  vi.clearAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});
afterAll(async () => {
  if (createdDir) {
    await rmdir(dir).catch(error => {
      if (error.code !== 'ENOTEMPTY') throw error;
    });
  }
});

async function listen(id: string, respond: (peer: Socket, line: string) => void) {
  const server = createServer(peer => {
    let request = '';
    peer.setEncoding('utf8').on('data', chunk => {
      request += chunk;
      if (request.includes('\n')) respond(peer, request);
    });
  });
  const path = socketPath(id);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(path, resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await chmod(path, 0o600);
}

describe('deferred registration frames', () => {
  it('reads only the authenticated launch identity when a bridge reconnects', async () => {
    const { launch_id, name, team } = identity();
    const key = randomUUID();
    const requests: string[] = [];
    await listen(launch_id, (peer, request) => {
      requests.push(request);
      peer.end(JSON.stringify({ status: 'bound', name, team }) + '\n');
    });
    expect(await readAgyBoundIdentity(launch_id, key)).toEqual({ status: 'bound', name, team });
    const { attempt } = JSON.parse(requests[0]);
    const proof = createHmac('sha256', key).update(
      ['xats-agy-defer-v1', 'status', launch_id, '', '', attempt].join('\0'),
    ).digest('hex');
    expect(JSON.parse(requests[0])).toEqual({ op: 'status', launch_id, attempt, proof });
  });

  it.each([['prepare', 'prepared'], ['commit', 'bound'], ['abort', 'released']] as const)(
    'authenticates %s using the launch and exact identity', async (op, status) => {
      const args = { ...identity(), name: '🪐'.repeat(256), attempt: randomUUID() };
      const key = randomUUID();
      let frame = '';
      await listen(args.launch_id, (peer, request) => {
        frame = request;
        peer.end(JSON.stringify({ status }) + '\n');
      });
      expect(await requestAgyClaim(op, args, key)).toEqual({ status });
      const proof = createHmac('sha256', key).update([
        'xats-agy-defer-v1', op, args.launch_id, args.name, args.team, args.attempt,
      ].join('\0')).digest('hex');
      expect(JSON.parse(frame)).toEqual({ ...args, op, proof });
      expect(frame).not.toContain(key);
    },
  );

  it('refuses ambiguous labels and short keys before connecting', async () => {
    const args = { ...identity(), attempt: randomUUID() };
    const handler = vi.fn();
    await listen(args.launch_id, handler);
    expect((await requestAgyClaim('prepare', { ...args, name: 'a\0b' },
      randomUUID())).status).toBe('unavailable');
    expect((await requestAgyClaim('prepare', args, 'weak')).status).toBe('unavailable');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('requestAgyLauncher', () => {
  it.each([
    ['probe', 'ready'], ['wake', 'delivered'],
    ['wake', 'busy'], ['probe', 'unavailable'],
  ] as const)('sends one %s line and reads %s', async (op, status) => {
    const args = identity();
    const response = { status, detail: '诊断' };
    const bytes = Buffer.from(JSON.stringify(response) + '\n');
    let received = '';
    await listen(args.launch_id, (peer, line) => {
      received = line;
      const split = bytes.indexOf('诊') + 1;
      peer.write(bytes.subarray(0, split));
      setImmediate(() => peer.write(bytes.subarray(split)));
    });
    expect(await requestAgyLauncher(op, args)).toEqual(response);
    expect(received).toBe(JSON.stringify({ op, ...args }) + '\n');
  });

  it.each([
    ['{"status":"other"}\n', /invalid launcher response/],
    ['{"status":"ready","detail":4}\n', /detail/],
    ['{"status":"ready","prompt":"extra"}\n', /prompt/],
    ['{oops}\n', /invalid launcher response/],
    [Buffer.from([0x22, 0xff, 0x22, 10]), /invalid launcher response/],
    ['{"status":"ready"}', /closed before/],
    ['{"status":"ready"}\n{}\n', /unexpected data/],
    ['x'.repeat(4097), /byte limit/],
  ] as const)('rejects invalid response %#', async (bytes, detail) => {
    const args = identity();
    await listen(args.launch_id, peer => peer.end(bytes));
    expect(await requestAgyLauncher('probe', args)).toMatchObject({
      status: 'unavailable', detail: expect.stringMatching(detail),
    });
  });

  it('times out even while bytes keep arriving', async () => {
    const args = identity();
    await listen(args.launch_id, peer => {
      const timer = setInterval(() => peer.write(' '), 50);
      peer.once('close', () => clearInterval(timer));
    });
    expect(await requestAgyLauncher('probe', args)).toMatchObject({
      status: 'unavailable', detail: expect.stringContaining('timed out'),
    });
  });

  it('preserves the filesystem error for a missing endpoint', async () => {
    expect(await requestAgyLauncher('probe', identity())).toMatchObject({
      status: 'unavailable', detail: expect.stringContaining('ENOENT'),
    });
  });

  it('rejects a socket with group permissions before connecting', async () => {
    const args = identity();
    const handler = vi.fn((peer: Socket) => peer.end('{"status":"ready"}\n'));
    await listen(args.launch_id, handler);
    await chmod(socketPath(args.launch_id), 0o660);
    expect(await requestAgyLauncher('probe', args)).toMatchObject({
      status: 'unavailable', detail: expect.stringContaining('unsafe launcher socket'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['directory', 'owner'], ['directory', 'mode'], ['socket', 'owner'],
  ] as const)('rejects unsafe %s %s', async (target, field) => {
    const args = identity();
    const path = socketPath(args.launch_id);
    const handler = vi.fn((peer: Socket) => peer.end('{"status":"ready"}\n'));
    await listen(args.launch_id, handler);
    const info = await lstat(target === 'directory' ? dir : path);
    const metadata = field === 'owner' ? { uid: uid + 1 } : { mode: info.mode | 7 };
    if (target === 'socket') vi.mocked(lstat).mockResolvedValueOnce(await lstat(dir));
    vi.mocked(lstat).mockResolvedValueOnce(Object.assign(info, metadata));
    expect(await requestAgyLauncher('probe', args)).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining(`unsafe launcher ${target}`),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['file', 'symlink'])('rejects a %s socket path', async type => {
    const args = identity();
    const path = socketPath(args.launch_id);
    if (type === 'file') await writeFile(path, '', { mode: 0o600, flag: 'wx' });
    else await symlink(socketPath(randomUUID()), path);
    cleanup.push(() => unlink(path));
    expect(await requestAgyLauncher('wake', args)).toMatchObject({
      status: 'unavailable', detail: expect.stringContaining('unsafe launcher socket'),
    });
  });

  it('rejects invalid operations, addresses and prompt fields', async () => {
    const args = identity();
    const handler = vi.fn((peer: Socket) => peer.end('{"status":"ready"}\n'));
    await listen(args.launch_id, handler);
    for (const overrides of [
      { launch_id: '../socket' }, { url: 'http://localhost' },
      { socket_path: '/tmp/other' }, { prompt: 'extra' }, { op: 'wake' },
    ]) {
      const result = await requestAgyLauncher('probe', { ...args, ...overrides });
      expect(result.status).toBe('unavailable');
    }
    const invalid = await requestAgyLauncher('send' as 'wake', args);
    expect(invalid.status).toBe('unavailable');
    expect(handler).not.toHaveBeenCalled();
  });
});
