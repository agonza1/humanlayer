import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface Identity {
	pid: number
	parent: number
	started: string
	state: string
}

// Layout and signatures: macOS SDK sys/proc_info.h proc_bsdinfo and libproc.h.
export const DARWIN_PROCESS_TABLE = String.raw`
import ctypes as c, errno, json, os, sys
class BSDInfo(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
        'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', c.c_char * 16), ('name', c.c_char * 32)]
    _fields_ += [(name, c.c_uint32) for name in ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')]
    _fields_ += [('nice', c.c_int32), ('seconds', c.c_uint64), ('microseconds', c.c_uint64)]
assert c.sizeof(BSDInfo) == 136
lib = c.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_listallpids.argtypes = [c.c_void_p, c.c_int]
lib.proc_listallpids.restype = c.c_int
lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
lib.proc_pidinfo.restype = c.c_int
def read(pid, required=False):
    info = BSDInfo()
    c.set_errno(0)
    size = lib.proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info))
    if size != c.sizeof(info):
        error = c.get_errno()
        if not required and error in (errno.ESRCH, errno.EPERM, errno.EACCES):
            return None
        raise OSError(error, 'Could not inspect process metadata', pid)
    if info.pid != pid:
        raise RuntimeError('Process identity mismatch')
    return dict(pid=info.pid, parent=info.ppid,
                state='Z' if info.status == 5 else '',
                started=str(info.seconds) + ':' + str(info.microseconds))
supervisor = int(sys.argv[1])
if os.getppid() != supervisor:
    raise RuntimeError('Inspector supervisor mismatch')
parent = read(supervisor, required=True)
for attempt in range(4):
    count = lib.proc_listallpids(None, 0)
    if count <= 0:
        raise OSError(c.get_errno(), 'Could not enumerate processes')
    pids = (c.c_int * (count + 256))()
    count = lib.proc_listallpids(pids, c.sizeof(pids))
    if count <= 0:
        raise OSError(c.get_errno(), 'Could not enumerate processes')
    if count < len(pids):
        break
else:
    raise RuntimeError('Process table did not stabilize')
rows = [read(pid) for pid in pids[:count] if pid > 0 and pid != supervisor]
print(json.dumps([parent] + [row for row in rows if row is not None]))
`

export async function processTable(platform: NodeJS.Platform = process.platform): Promise<Identity[]> {
	if (platform === 'darwin') {
		// /usr/bin/python3 is an xcrun launcher and may write outside a sandbox's temp roots.
		const python =
			process.env.HUMANLAYER_PROCESS_INSPECTOR_PYTHON ||
			[
				'/Library/Developer/CommandLineTools/usr/bin/python3',
				'/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
			].find((path) => existsSync(path)) ||
			'/usr/bin/python3'
		const stdout = await inspectDarwin(python)
		const table: Identity[] = JSON.parse(stdout)
		if (!table.some((entry) => entry.pid === process.pid)) throw new Error('Supervisor metadata unavailable')
		return table
	}
	const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 2_000 })
	const table = stdout.split('\n').flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
		return match
			? [{ pid: Number(match[1]), parent: Number(match[2]), state: match[3] ?? '', started: match[4] ?? '' }]
			: []
	})
	if (!table.some((entry) => entry.pid === process.pid)) throw new Error('Supervisor metadata unavailable')
	return table
}

async function inspectDarwin(python: string): Promise<string> {
	for (const timeout of [2_000, 5_000]) {
		try {
			return (
				await exec(python, ['-I', '-c', DARWIN_PROCESS_TABLE, String(process.pid)], {
					timeout,
					maxBuffer: 4 * 1024 * 1024,
				})
			).stdout
		} catch (error) {
			const failure = error as Error & {
				code?: string | number | null
				signal?: string | null
				killed?: boolean
				stderr?: string
			}
			// execFile marks its own deadline kill; permission and other failures are never retried.
			if (timeout === 2_000 && failure.killed && failure.signal === 'SIGTERM') continue
			throw new Error(
				`Could not inspect process metadata. ${JSON.stringify({
					code: failure.code,
					signal: failure.signal,
					killed: failure.killed,
					detail: failure.stderr?.trim() || failure.message,
				})}`,
				{ cause: error },
			)
		}
	}
	throw new Error('Could not inspect process metadata.')
}

export function coalesceSamples<T>(inspect: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined
	return () => {
		if (!pending)
			pending = inspect().finally(() => {
				pending = undefined
			})
		return pending
	}
}
