import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, run } from './proc.ts';

export interface TaskCheckpoint {
    task: string;
    root: string;
    branch: string;
    base: string;
    index: string;
    tree: string;
    ref: string;
    protected: string[];
    untracked: string[];
    commits: string[];
    turn?: { session: string; head: string };
}

function protectedPath(path: string, roots: string[]): boolean {
    return roots.some((root) => path === root || path.startsWith(root + '/'));
}

function paths(protectedRoots: string[]): string[] {
    return ['.', ...protectedRoots.map((p) => `:(top,literal,exclude)${p}`)];
}

async function branch(root: string): Promise<string> {
    return (await git(root, 'rev-parse', '--symbolic-full-name', 'HEAD')).trim();
}

async function snapshot(root: string, directory: string, protectedRoots: string[]) {
    mkdirSync(directory, { recursive: true });
    const temporaryIndex = resolve(directory, `index-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    const indexedGit = async (...args: string[]) => {
        const r = await run('git', args, root, undefined, env);
        if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.output.trim()}`);
        return r.output.trim();
    };
    try {
        const index = (await git(root, 'write-tree')).trim();
        // Seed from the real index to preserve staged additions, then capture the working files
        // in a separate index. The user's index and working tree are never stashed or rewritten.
        await indexedGit('read-tree', index);
        const files = [...new Set((await git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')).split('\0'))]
            .filter((p) => p && !protectedPath(p, protectedRoots));
        if (files.length) {
            writeFileSync(temporaryIndex + '.paths', files.map((p) => `:(top,literal)${p}\0`).join(''));
            await indexedGit('add', '-A', `--pathspec-from-file=${temporaryIndex}.paths`, '--pathspec-file-nul');
        }
        const tree = await indexedGit('write-tree');
        const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0')
            .filter((p) => p && !protectedPath(p, protectedRoots));
        return { index, tree, untracked };
    } finally {
        rmSync(temporaryIndex, { force: true });
        rmSync(temporaryIndex + '.lock', { force: true });
        rmSync(temporaryIndex + '.paths', { force: true });
    }
}

async function saveSnapshot(root: string, ref: string, base: string, index: string, tree: string) {
    const indexCommit = (await git(root, 'commit-tree', index, '-p', base, '-m', 'Telebaton index checkpoint')).trim();
    const workCommit = (await git(root, 'commit-tree', tree, '-p', base, '-p', indexCommit, '-m', 'Telebaton worktree checkpoint')).trim();
    await git(root, 'update-ref', ref, workCommit);
}

export async function captureTaskCheckpoint(root: string, task: string, directory: string, protectedDirectories: string[]): Promise<TaskCheckpoint> {
    const protectedRoots = protectedDirectories.map((path) => relative(root, resolve(path)))
        .filter((p) => p && p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p)).map((p) => p.split(sep).join('/'));
    if (protectedDirectories.some((path) => resolve(path) === resolve(root))) throw new Error('the project root cannot be used as the log/state directory for an abort checkpoint');
    const base = (await git(root, 'rev-parse', 'HEAD')).trim();
    const saved = await snapshot(root, directory, protectedRoots);
    const ref = `refs/telebaton/checkpoints/${randomUUID()}`;
    await saveSnapshot(root, ref, base, saved.index, saved.tree);
    return { task, root: resolve(root), branch: await branch(root), base, ...saved, ref, protected: protectedRoots, commits: [] };
}

export async function recordTaskCommits(checkpoint: TaskCheckpoint) {
    if (!checkpoint.turn) return;
    const commits = (await git(checkpoint.root, 'rev-list', `${checkpoint.turn.head}..HEAD`)).trim().split('\n').filter(Boolean);
    checkpoint.commits = [...new Set([...checkpoint.commits, ...commits])];
}

export async function validateTaskRollback(checkpoint: TaskCheckpoint) {
    if (await branch(checkpoint.root) !== checkpoint.branch) throw new Error('the branch changed since this task started; restore it before /abort');
    const ancestry = await run('git', ['merge-base', '--is-ancestor', checkpoint.base, 'HEAD'], checkpoint.root);
    if (ancestry.code !== 0) throw new Error('the task starting commit is no longer an ancestor of HEAD; rollback requires manual reconciliation');
    const commits = (await git(checkpoint.root, 'rev-list', `${checkpoint.base}..HEAD`)).trim().split('\n').filter(Boolean);
    const unknown = commits.filter((sha) => !checkpoint.commits.includes(sha));
    if (unknown.length) throw new Error(`commits outside recorded task turns would be removed: ${unknown.map((sha) => sha.slice(0, 12)).join(', ')}; reconcile them before /abort`);
}

export async function backUpTaskAbort(checkpoint: TaskCheckpoint, directory: string): Promise<string> {
    await validateTaskRollback(checkpoint);
    const head = (await git(checkpoint.root, 'rev-parse', 'HEAD')).trim();
    const saved = await snapshot(checkpoint.root, directory, checkpoint.protected);
    await validateTaskRollback(checkpoint);
    if ((await git(checkpoint.root, 'rev-parse', 'HEAD')).trim() !== head) throw new Error('HEAD changed while preparing the recovery snapshot');
    const ref = `refs/telebaton/aborts/${randomUUID()}`;
    await saveSnapshot(checkpoint.root, ref, head, saved.index, saved.tree);
    return ref;
}

export async function restoreTaskCheckpoint(checkpoint: TaskCheckpoint, expectedHead?: string) {
    if (await branch(checkpoint.root) !== checkpoint.branch) throw new Error('the branch changed while aborting; restore it before retrying /abort');
    const current = (await git(checkpoint.root, 'rev-parse', 'HEAD')).trim();
    if (expectedHead && current !== expectedHead && current !== checkpoint.base) throw new Error('HEAD changed after the rollback was prepared; reconcile it before retrying /abort');
    const untracked = (await git(checkpoint.root, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0')
        .filter((p) => p && !protectedPath(p, checkpoint.protected) && !checkpoint.untracked.includes(p));
    // These are only non-ignored files absent at task start. Never recursively remove a
    // directory (e.g. a nested repository), follow symlinks, or clean ignored build/log output.
    for (const path of untracked) {
        const file = resolve(checkpoint.root, path);
        const within = relative(checkpoint.root, file);
        if (isAbsolute(within) || within.startsWith('..' + sep) || within === '..') throw new Error('invalid untracked file path');
        if (lstatSync(file).isDirectory()) throw new Error(`untracked directory ${path} needs manual handling before /abort`);
    }
    // Compare-and-swap the ref: a concurrent commit must never be silently rewound.
    if (current !== checkpoint.base) await git(checkpoint.root, 'update-ref', '-m', 'Telebaton task abort', checkpoint.branch, checkpoint.base, expectedHead ?? current);
    const unchangedHead = async () => {
        if ((await git(checkpoint.root, 'rev-parse', 'HEAD')).trim() !== checkpoint.base) throw new Error('HEAD changed during rollback; reconcile it before retrying /abort');
    };
    await unchangedHead();
    await git(checkpoint.root, 'restore', `--source=${checkpoint.tree}`, '--staged', '--worktree', '--', ...paths(checkpoint.protected));
    await unchangedHead();
    await git(checkpoint.root, 'restore', `--source=${checkpoint.index}`, '--staged', '--', ...paths(checkpoint.protected));
    await unchangedHead();
    for (const path of untracked) rmSync(resolve(checkpoint.root, path), { force: true });
}
