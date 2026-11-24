import { createHmac, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { z } from 'zod';
import { agyLaunchIdSchema } from '../lib/delivery-spec.js';

const TIMEOUT_MS = 1500;
const MAX_REPLY_BYTES = 4096;
const operation = z.enum(['probe', 'wake']);
const label = z.string().refine(value => value.trim().length > 0, 'empty label');
const launcherArgs = z.object({
  launch_id: agyLaunchIdSchema,
  name: label,
  team: label,
}).strict();
const reply = z.object({
  status: z.enum(['ready', 'delivered', 'busy', 'unavailable']),
  detail: z.string().optional(),
}).strict();

type LauncherArgs = z.infer<typeof launcherArgs>;
type LauncherReply = z.infer<typeof reply>;

function checkEndpoint(
  info: Stats, uid: number, type: 'directory' | 'socket',
): void {
  const validType = type === 'directory' ? info.isDirectory() : info.isSocket();
  const prefix = `unsafe launcher ${type}`;
  if (!validType) throw new Error(`${prefix}: unexpected file type`);
  if (info.uid !== uid) {
    throw new Error(`${prefix}: owner ${info.uid}, expected ${uid}`);
  }
  if (info.mode & 0o077) {
    throw new Error(`${prefix}: permissions ${(info.mode & 0o777).toString(8)}`);
  }
}

async function launcherSocket(launchId: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('local uid unavailable');
  const dir = `/tmp/xats-agy-${uid}`;
  const path = `${dir}/${launchId}.sock`;
  checkEndpoint(await lstat(dir), uid, 'directory');
  checkEndpoint(await lstat(path), uid, 'socket');
  return path;
}

function exchange<T>(path: string, request: string, schema: z.ZodType<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    function fail(error: Error) {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    const timer = setTimeout(() => fail(new Error('launcher timed out')), TIMEOUT_MS);
    const frame = Buffer.alloc(MAX_REPLY_BYTES);
    let length = 0;
    socket.once('error', fail);
    socket.once('connect', () => socket.write(request));
    socket.once('end', () => fail(new Error('launcher closed before response LF')));
    socket.on('data', (chunk: Buffer) => {
      if (length + chunk.length > frame.length) {
        return fail(new Error('launcher response exceeds byte limit'));
      }
      chunk.copy(frame, length);
      length += chunk.length;
      const lf = chunk.indexOf(0x0a);
      if (lf < 0) return;
      if (lf !== chunk.length - 1) {
        return fail(new Error('unexpected data after launcher response LF'));
      }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const line = decoder.decode(frame.subarray(0, length - 1));
        const result = schema.parse(JSON.parse(line));
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      } catch (error) {
        fail(new Error(`invalid launcher response: ${errorMessage(error)}`));
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function requestAgyLauncher(
  op: 'probe' | 'wake',
  args: LauncherArgs,
): Promise<LauncherReply> {
  try {
    operation.parse(op);
    const fields = launcherArgs.parse(args);
    const path = await launcherSocket(fields.launch_id);
    return await exchange(path, JSON.stringify({ op, ...fields }) + '\n', reply);
  } catch (error) {
    return { status: 'unavailable', detail: errorMessage(error) };
  }
}

const claimOp = z.enum(['prepare', 'commit', 'abort']);
const claimLabel = z.string().min(1).refine(value =>
  value === value.trim() && Array.from(value).length <= 256 &&
  !/[\x00\uD800-\uDFFF]/u.test(value));
const claimArgs = z.object({
  launch_id: agyLaunchIdSchema,
  name: claimLabel,
  team: claimLabel,
  attempt: agyLaunchIdSchema,
}).strict();
const claimReply = z.object({
  status: z.enum(['prepared', 'bound', 'released', 'unavailable']),
  detail: z.string().optional(),
}).strict();
const boundIdentity = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unbound') }).strict(),
  z.object({ status: z.literal('bound'), name: claimLabel, team: claimLabel }).strict(),
  z.object({ status: z.literal('unavailable'), detail: z.string().optional() }).strict(),
]);

function signClaim(op: string, fields: z.infer<typeof claimArgs>, key: string) {
  const size = Buffer.byteLength(key, 'utf8');
  if (size < 16 || size > 256) throw new Error('Invalid slot key length');
  const frame = ['xats-agy-defer-v1', op, fields.launch_id,
    fields.name, fields.team, fields.attempt].join('\0');
  return createHmac('sha256', key).update(frame).digest('hex');
}

export async function requestAgyClaim(
  op: z.infer<typeof claimOp>, args: z.infer<typeof claimArgs>, key: string,
): Promise<z.infer<typeof claimReply>> {
  try {
    claimOp.parse(op);
    const fields = claimArgs.parse(args);
    const proof = signClaim(op, fields, key);
    const path = await launcherSocket(fields.launch_id);
    return await exchange(path, JSON.stringify({ op, ...fields, proof }) + '\n', claimReply);
  } catch (error) {
    return { status: 'unavailable', detail: errorMessage(error) };
  }
}

export async function readAgyBoundIdentity(
  launchId: string, key: string,
): Promise<z.infer<typeof boundIdentity>> {
  try {
    const launch_id = agyLaunchIdSchema.parse(launchId);
    const attempt = randomUUID();
    const proof = signClaim('status', { launch_id, attempt, name: '', team: '' }, key);
    const frame = { op: 'status', launch_id, attempt, proof };
    return await exchange(await launcherSocket(launch_id), JSON.stringify(frame) + '\n',
      boundIdentity);
  } catch (error) {
    return { status: 'unavailable', detail: errorMessage(error) };
  }
}
