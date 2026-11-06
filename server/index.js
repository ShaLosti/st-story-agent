// Lore Agent — server plugin.
// POST /api/plugins/lore-agent/run
//   { book, text, system, task, model, thinking, timeoutSec }
// Writes `text` to worlds/_lore-agent/<book>/story_state.md, runs the pi agent there
// (read + edit tools only) with `system` as its system prompt and `task` as the user
// message, and returns the edited file plus exactly what was sent.
// All prompt text comes from the extension (editable in its settings).
// SillyTavern lists only *.json files in worlds/, so the subfolder is invisible to it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const info = {
    id: 'lore-agent',
    name: 'Lore Agent',
    description: 'Runs a pi agent that edits the Story State lorebook entry.',
};

const FILE = 'story_state.md';

/** One run per book at a time. */
const queues = new Map();
function enqueue(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.catch(() => { }).then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => { });
    return next;
}

function piCommand() {
    const custom = process.env.LORE_AGENT_PI_CLI;
    if (custom && fs.existsSync(custom)) return { cmd: process.execPath, pre: [custom], shell: false };
    const appdata = process.env.APPDATA;
    if (appdata) {
        const cli = path.join(appdata, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
        if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], shell: false };
    }
    return { cmd: process.platform === 'win32' ? 'pi.cmd' : 'pi', pre: [], shell: process.platform === 'win32' };
}

function runPi({ dir, system, task, model, thinking, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const { cmd, pre, shell } = piCommand();
        const args = [
            ...pre,
            '-p', '--no-session',
            '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
            '--tools', 'read,edit',
            '--model', model,
            '--thinking', thinking,
            '--system-prompt', system,
        ];
        // The task goes in through stdin (pi -p reads piped stdin as the message), so it has
        // no command-line length limit and no special meaning for a leading "-" or "@".
        const child = spawn(cmd, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.stdin.on('error', () => { });
        child.stdin.end(task, 'utf8');
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`pi timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`pi exited with code ${code}: ${(stderr || stdout).trim().slice(-800)}`));
        });
    });
}

async function init(router) {
    router.post('/run', async (req, res) => {
        try {
            const body = req.body || {};
            const book = String(body.book || '');
            const text = String(body.text ?? '');
            const system = String(body.system ?? '');
            const task = String(body.task ?? '');
            const model = String(body.model || 'openai-codex/gpt-6.1-sol');
            const thinking = String(body.thinking || 'low');
            const timeoutMs = Math.max(30, Number(body.timeoutSec) || 180) * 1000;

            const worlds = req.user?.directories?.worlds;
            if (!worlds) return res.status(500).send('User directories are not available.');
            if (!book) return res.status(400).send('Missing book name.');
            if (!system.trim() || !task.trim()) return res.status(400).send('Missing system prompt or task.');

            const safe = book.replace(/[^\p{L}\p{N} _.-]/gu, '_').replace(/^\.+/, '').slice(0, 100) || 'book';
            const dir = path.join(worlds, '_lore-agent', safe);

            const result = await enqueue(dir, async () => {
                await fs.promises.mkdir(dir, { recursive: true });
                const file = path.join(dir, FILE);
                await fs.promises.writeFile(file, text, 'utf8');

                const started = Date.now();
                const { stdout } = await runPi({ dir, system, task, model, thinking, timeoutMs });
                const edited = await fs.promises.readFile(file, 'utf8');
                return {
                    text: edited,
                    summary: stdout.trim().split('\n').filter(Boolean).slice(-3).join('\n'),
                    output: stdout.trim(),
                    seconds: Math.round((Date.now() - started) / 1000),
                    // What pi actually sends: our system prompt plus its own <cwd> section
                    // (tools are sent separately as tool definitions: read, edit).
                    sent: {
                        system: `${system}\n\n<cwd>\n${dir.replace(/\\/g, '/')}\n</cwd>`,
                        task,
                        model,
                        thinking,
                    },
                };
            });

            return res.json(result);
        } catch (error) {
            console.error('[lore-agent]', error);
            return res.status(500).send(String(error?.message || error));
        }
    });

    console.log('[lore-agent] ready at /api/plugins/lore-agent/run');
}

async function exit() { }

module.exports = { init, exit, info };
