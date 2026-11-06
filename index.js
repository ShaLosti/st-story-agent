// Lore Agent — browser extension.
//
// The main model ends a reply with <lore_edits>…</lore_edits>. Nothing happens when the
// reply arrives. When the next generation starts (send, swipe, regenerate, continue),
// the generate interceptor first brings the "📒 Story State" entry of the character
// lorebook in line with the chat, then lets the main model generate:
//
//   * Every committed AI message stores { before, after, sig } in message.extra.loreAgent.
//   * The newest message whose record is intact (same instructions, chain unbroken) gives
//     the base state; deleted, swiped or edited messages after it are re-applied in order.
//   * Applying a message = if it has instructions, the pi agent edits the text through
//     the lore-agent server plugin.
//
// The state is per chat even though the entry lives in the character lorebook: opening a
// chat writes that chat's state into the entry. Manual edits of the entry are kept.

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, createWorldInfoEntry, world_info_position, reloadEditor } from '../../../world-info.js';
import { promptManager } from '../../../openai.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

const MODULE = 'loreAgent';
const ENTRY_NAME = '📒 Story State';
const TOGGLE_ID = 'loreAgentEdits';
const PLUGIN_URL = '/api/plugins/lore-agent/run';

// The entry starts empty; the main model creates its sections through <lore_edits>.
const DEFAULT_STATE = `<story_state>
</story_state>`;

// Prompts sent to the pi agent. Editable in the extension settings.
// Task placeholders: {{last_message}}, {{lore_edits}}.
const DEFAULT_SYSTEM = `You maintain story_state.md, the persistent state of a roleplay story.
Apply the instructions in <lore_edits> to that file with your edit tool. Change only what they ask; keep the tags and the format.
Keep the entries of each section as a numbered list (1., 2., ...) and renumber after removals. Numbers in <lore_edits> refer to the file as it was before your edits.
Use <last_message> only to understand the instructions.
Reply with one short line saying what you changed.`;

const DEFAULT_TASK = `<last_message>
{{last_message}}
</last_message>

<lore_edits>
{{lore_edits}}
</lore_edits>`;

const DEFAULTS = {
    enabled: true,
    model: 'openai-codex/gpt-6.1-sol',
    thinking: 'low',
    timeoutSec: 180,
    depth: 1,
    systemPrompt: '', // '' = DEFAULT_SYSTEM
    taskPrompt: '', // '' = DEFAULT_TASK
    lastWrite: null, // { chatId, book, hash } — the last text this extension wrote
};

const EDITS_RE = /<lore_edits>([\s\S]*?)(?:<\/lore_edits>|$)/gi;

function settings() {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE] || {});
    return extension_settings[MODULE];
}

function hash(str) {
    let h = 5381;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
}

function extractEdits(mes) {
    const out = [];
    for (const m of String(mes || '').matchAll(EDITS_RE)) {
        const t = m[1].trim();
        if (t) out.push(t);
    }
    return out.join('\n\n');
}

function stripEdits(mes) {
    return String(mes || '').replace(EDITS_RE, '').trim();
}

function sigOf(msg) {
    return hash(extractEdits(msg.mes));
}

function normalize(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').trim();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── records ─────────────────────────────────────────────────────────────────

function getRecord(msg) {
    return msg?.extra?.loreAgent || null;
}

function setRecord(msg, record) {
    msg.extra ??= {};
    msg.extra.loreAgent = record;
    const swipeExtra = msg.swipe_info?.[msg.swipe_id]?.extra;
    if (swipeExtra && swipeExtra !== msg.extra) swipeExtra.loreAgent = structuredClone(record);
}

/**
 * Decide the base state and which AI messages still need applying.
 * @param {object[]} msgs AI messages that are final for this generation, oldest first
 */
function plan(msgs) {
    const firstRec = msgs.findIndex(m => getRecord(m));
    if (firstRec === -1) {
        return { base: DEFAULT_STATE, lastValid: null, apply: msgs.length ? [msgs[msgs.length - 1]] : [], invalidated: false };
    }
    let prevAfter = null;
    let lastValid = null;
    for (let i = firstRec; i < msgs.length; i++) {
        const m = msgs[i];
        const r = getRecord(m);
        const ok = r && r.sig === sigOf(m) && (prevAfter === null || r.before === prevAfter);
        if (!ok) {
            const base = prevAfter ?? (r ? r.before : DEFAULT_STATE);
            const apply = msgs.slice(i);
            return { base, lastValid, apply, invalidated: apply.some(x => getRecord(x)) };
        }
        prevAfter = r.after;
        lastValid = m;
    }
    return { base: prevAfter, lastValid, apply: [], invalidated: false };
}

// ── lorebook ────────────────────────────────────────────────────────────────

function findEntry(data) {
    return Object.values(data?.entries || {}).find(e => e.comment === ENTRY_NAME) || null;
}

async function readEntry(book) {
    const data = await loadWorldInfo(book);
    const entry = findEntry(data);
    return entry ? normalize(entry.content) : null;
}

async function writeEntry(book, text) {
    const data = await loadWorldInfo(book);
    if (!data) throw new Error(`Lorebook "${book}" not found.`);
    let entry = findEntry(data);
    if (!entry) {
        entry = createWorldInfoEntry(book, data);
        Object.assign(entry, {
            comment: ENTRY_NAME,
            key: [],
            constant: true,
            position: world_info_position.atDepth,
            depth: Number(settings().depth) || 1,
            role: 0, // system
            order: 100,
            disable: false,
        });
    } else if (normalize(entry.content) === text) {
        return;
    }
    entry.content = text;
    await saveWorldInfo(book, data, true);
    try { reloadEditor(book); } catch { /* editor not open */ }
}

function rememberWrite(chatId, book, text) {
    settings().lastWrite = { chatId, book, hash: hash(text) };
    saveSettingsDebounced();
}

// ── target ──────────────────────────────────────────────────────────────────

const warned = new Set();

function isToggleOn() {
    try {
        return !!promptManager?.getPromptOrderEntry(promptManager.activeCharacter, TOGGLE_ID)?.enabled;
    } catch {
        return false;
    }
}

function getTarget() {
    if (!settings().enabled) return null;
    const ctx = getContext();
    if (ctx.mainApi !== 'openai' || ctx.groupId) return null;
    if (!isToggleOn()) return null;
    const chatId = ctx.getCurrentChatId?.();
    if (!chatId) return null;
    const ch = ctx.characters?.[ctx.characterId];
    const book = ch?.data?.extensions?.world;
    if (!book) {
        if (ch && !warned.has(ch.avatar)) {
            warned.add(ch.avatar);
            toastr.warning(`${ch.name} has no character lorebook. Link one to use Lore Agent.`, 'Lore Agent');
        }
        return null;
    }
    return { book, chatId };
}

function aiMessages(list) {
    return list.filter(m => m && !m.is_user && !m.is_system);
}

// ── agent ───────────────────────────────────────────────────────────────────

const PROMPT_FIELDS = {
    systemPrompt: DEFAULT_SYSTEM,
    taskPrompt: DEFAULT_TASK,
};

function promptText(key) {
    const v = settings()[key];
    return typeof v === 'string' && v.trim() ? v : PROMPT_FIELDS[key];
}

/** Build exactly what is sent to pi: system prompt and task (user message). */
function buildPrompts({ reply, instructions }) {
    const vars = {
        last_message: reply,
        lore_edits: instructions || '(none)',
    };
    const task = promptText('taskPrompt')
        .replace(/\{\{(last_message|lore_edits)\}\}/g, (_, k) => vars[k])
        .trim();
    return { system: promptText('systemPrompt').trim(), task };
}

const LAST_SENT_KEY = 'loreAgent_lastSent';

function saveLastSent(data) {
    try { localStorage.setItem(LAST_SENT_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function loadLastSent() {
    try { return JSON.parse(localStorage.getItem(LAST_SENT_KEY) || 'null'); } catch { return null; }
}

async function runAgent({ book, text, reply, instructions }) {
    const s = settings();
    const ctx = getContext();
    const { system, task } = buildPrompts({ reply, instructions });
    const res = await fetch(PLUGIN_URL, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ book, text, system, task, model: s.model, thinking: s.thinking, timeoutSec: s.timeoutSec }),
    });
    if (res.status === 404) throw new Error('Server plugin "lore-agent" is not loaded. Restart SillyTavern.');
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const json = await res.json();
    const out = normalize(json.text);
    saveLastSent({
        at: new Date().toLocaleString(),
        book,
        model: json.sent?.model ?? s.model,
        thinking: json.sent?.thinking ?? s.thinking,
        system: json.sent?.system ?? system,
        task: json.sent?.task ?? task,
        fileBefore: text,
        fileAfter: out,
        output: json.output ?? json.summary ?? '',
        seconds: json.seconds,
    });
    if (!out) throw new Error('The agent returned an empty file.');
    return { text: out, summary: json.summary || '', seconds: json.seconds };
}

const STOP = Symbol('stop');

async function askOnFailure(error) {
    const result = await callGenericPopup(
        `<h3>Lore Agent failed</h3><p>${escapeHtml(error?.message || error)}</p>`,
        POPUP_TYPE.CONFIRM, '',
        {
            okButton: 'Retry',
            cancelButton: 'Skip this edit',
            customButtons: [{ text: 'Stop generation', result: POPUP_RESULT.CUSTOM1 }],
        });
    if (result === POPUP_RESULT.AFFIRMATIVE) return 'retry';
    if (result === POPUP_RESULT.NEGATIVE) return 'skip';
    return 'stop';
}

/** Apply one AI message on top of `base`. Returns the new state, or STOP. */
async function commit(msg, base, book, { runAgentFor = true, step = '' } = {}) {
    let text = base;
    const instructions = extractEdits(msg.mes);

    if (runAgentFor && instructions) {
        const toast = toastr.info(`Updating story state${step}…`, 'Lore Agent', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
        try {
            for (;;) {
                try {
                    const r = await runAgent({ book, text, reply: stripEdits(msg.mes), instructions });
                    text = r.text;
                    toastr.success(escapeHtml(r.summary || 'Done.'), `Lore Agent${r.seconds ? ` (${r.seconds}s)` : ''}`, { timeOut: 6000 });
                    break;
                } catch (error) {
                    console.error('[Lore Agent]', error);
                    const choice = await askOnFailure(error);
                    if (choice === 'retry') continue;
                    if (choice === 'stop') return STOP;
                    break; // skip: keep the state without the edits
                }
            }
        } finally {
            toastr.clear(toast);
        }
    }

    setRecord(msg, { before: base, after: text, sig: sigOf(msg) });
    return text;
}

// ── sync ────────────────────────────────────────────────────────────────────

let busy = false;

/**
 * Bring the entry in line with `msgs`. With apply=false only restores (chat open).
 * @returns {Promise<boolean>} false when the user chose to stop
 */
async function sync(target, msgs, { apply }) {
    const { book, chatId } = target;
    const s = settings();
    const current = await readEntry(book);
    const p = plan(msgs);

    // Keep manual edits made to this chat's state in the World Info editor.
    const lw = s.lastWrite;
    const manual = current !== null && lw && lw.chatId === chatId && lw.book === book && hash(current) !== lw.hash;
    if (manual && !p.invalidated) {
        if (p.lastValid) setRecord(p.lastValid, { ...getRecord(p.lastValid), after: current });
        p.base = current;
    }

    let text = p.base;
    let stopped = false;
    let changedChat = manual && !p.invalidated && !!p.lastValid;

    if (apply && p.apply.length) {
        const withWork = p.apply.filter(m => extractEdits(m.mes));
        let runAll = true;
        if (withWork.length > 2) {
            const ok = await callGenericPopup(
                `<h3>Lore Agent</h3><p>${withWork.length} earlier replies with lore edits changed (deleted, edited or swiped). Re-run the agent for all of them? <br><small>No = run it only for the latest reply.</small></p>`,
                POPUP_TYPE.CONFIRM, '', { okButton: 'Re-run all', cancelButton: 'Latest only' });
            runAll = ok === POPUP_RESULT.AFFIRMATIVE;
        }
        const last = p.apply[p.apply.length - 1];
        let n = 0;
        for (const m of p.apply) {
            const work = !!extractEdits(m.mes);
            if (work) n++;
            const step = withWork.length > 1 && (runAll || m === last) ? ` ${n}/${withWork.length}` : '';
            const r = await commit(m, text, book, { runAgentFor: runAll || m === last, step });
            if (r === STOP) { stopped = true; break; }
            text = r;
            changedChat = true;
        }
    }

    await writeEntry(book, text);
    rememberWrite(chatId, book, text);
    if (changedChat) await getContext().saveChat();
    return !stopped;
}

globalThis.loreAgentInterceptor = async function (_coreChat, _contextSize, abort, type) {
    if (type === 'quiet' || type === 'impersonate' || busy) return;
    const target = getTarget();
    if (!target) return;
    busy = true;
    try {
        // Use the real chat, not the interceptor's copy: SillyTavern hands interceptors
        // copies whose text already went through prompt-only regex, which strips <lore_edits>.
        let list = (getContext().chat || []).filter(m => !m.is_system);
        // Swipe replaces the last reply and continue extends it: either way it is not final yet.
        // (Regenerate has already removed it from the chat by now.)
        if (type === 'swipe') list = list.slice(0, -1);
        else if (type === 'continue' && list.length && !list[list.length - 1].is_user) list = list.slice(0, -1);
        const ok = await sync(target, aiMessages(list), { apply: true });
        if (!ok) abort(true);
    } catch (error) {
        console.error('[Lore Agent]', error);
        toastr.error(escapeHtml(error?.message || error), 'Lore Agent');
    } finally {
        busy = false;
    }
};

async function onChatChanged() {
    if (busy) return;
    const target = getTarget();
    if (!target) return;
    busy = true;
    try {
        await sync(target, aiMessages(getContext().chat || []), { apply: false });
    } catch (error) {
        console.error('[Lore Agent]', error);
    } finally {
        busy = false;
    }
}

// ── prompt viewer ───────────────────────────────────────────────────────────

const PRE = 'style="white-space:pre-wrap;text-align:left;max-height:40vh;overflow:auto;font-size:0.85em;padding:6px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;"';

function block(title, text, note = '') {
    return `<h4 style="text-align:left;margin:10px 0 4px;">${escapeHtml(title)}</h4><pre ${PRE}>${escapeHtml(text ?? '')}</pre>${note ? `<div style="text-align:left;"><small>${note}</small></div>` : ''}`;
}

async function showPopup(html) {
    await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

async function previewNext() {
    const target = getTarget();
    if (!target) {
        toastr.warning('Not active here. It needs the preset toggle "📝 Lore Edits (agent)" on and a character lorebook.', 'Lore Agent');
        return;
    }
    const msgs = aiMessages(getContext().chat || []);
    const last = msgs[msgs.length - 1];
    if (!last) {
        toastr.info('No AI reply in this chat yet.', 'Lore Agent');
        return;
    }
    const current = await readEntry(target.book);
    const p = plan(msgs);
    const lw = settings().lastWrite;
    const manual = current !== null && lw && lw.chatId === target.chatId && lw.book === target.book && hash(current) !== lw.hash;

    let base;
    let note = '';
    if (!p.apply.length) {
        base = getRecord(last)?.before ?? current ?? DEFAULT_STATE;
        note = 'The latest reply is already applied. This is what it was applied with.';
    } else if (p.apply.length === 1) {
        base = manual && !p.invalidated ? current : p.base;
    } else {
        base = current ?? p.base;
        note = `${p.apply.length} replies are waiting to be applied; this shows only the latest one, on top of the current entry.`;
    }
    const text = base;
    const instructions = extractEdits(last.mes);
    if (!instructions) note = (note ? note + ' ' : '') + 'This reply has no <lore_edits>, so the agent will not run for it.';

    const { system, task } = buildPrompts({ reply: stripEdits(last.mes), instructions });
    const s = settings();
    await showPopup(
        `<h3>Next prompt to pi</h3><div style="text-align:left;"><small>Model: ${escapeHtml(s.model)} · thinking: ${escapeHtml(s.thinking)} · tools: read, edit${note ? '<br>' + escapeHtml(note) : ''}</small></div>`
        + block('System prompt', system, 'pi adds one section after it: &lt;cwd&gt; with the folder path (worlds/_lore-agent/&lt;lorebook&gt;).')
        + block('Task (user message)', task)
        + block('story_state.md (the agent reads and edits this file)', text));
}

async function showLastSent() {
    const d = loadLastSent();
    if (!d) {
        toastr.info('Nothing has been sent to pi yet.', 'Lore Agent');
        return;
    }
    await showPopup(
        `<h3>Last prompt sent to pi</h3><div style="text-align:left;"><small>${escapeHtml(d.at)} · ${escapeHtml(d.book)} · ${escapeHtml(d.model)} · thinking: ${escapeHtml(d.thinking)} · tools: read, edit${d.seconds ? ` · ${d.seconds}s` : ''}</small></div>`
        + block('System prompt (exact, including pi\'s <cwd> section)', d.system)
        + block('Task (user message)', d.task)
        + block('story_state.md before', d.fileBefore)
        + block('story_state.md after', d.fileAfter)
        + block('Agent reply', d.output));
}

// ── settings UI ─────────────────────────────────────────────────────────────

function renderSettings() {
    const s = settings();
    const html = `
<div class="lore-agent-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>📒 Lore Agent</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="lore_agent_enabled"><span>Enabled</span></label>
      <small>Works when the preset toggle "📝 Lore Edits (agent)" is on and the character has a lorebook.</small>
      <label for="lore_agent_model">pi model</label>
      <input id="lore_agent_model" class="text_pole" type="text">
      <label for="lore_agent_thinking">Thinking</label>
      <select id="lore_agent_thinking" class="text_pole">
        ${['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(x => `<option value="${x}">${x}</option>`).join('')}
      </select>
      <label for="lore_agent_timeout">Timeout (seconds)</label>
      <input id="lore_agent_timeout" class="text_pole" type="number" min="30" max="900">
      <hr>
      <b>Prompt sent to pi</b>
      <label for="lore_agent_system">System prompt</label>
      <textarea id="lore_agent_system" class="text_pole" rows="6"></textarea>
      <label for="lore_agent_task">Task (user message)</label>
      <small>Placeholders: {{last_message}}, {{lore_edits}}</small>
      <textarea id="lore_agent_task" class="text_pole" rows="9"></textarea>
      <div class="flex-container">
        <div id="lore_agent_preview" class="menu_button">Preview next prompt</div>
        <div id="lore_agent_last" class="menu_button">Show last sent</div>
        <div id="lore_agent_reset" class="menu_button">Reset prompts</div>
      </div>
    </div>
  </div>
</div>`;
    $('#extensions_settings2').append(html);

    const fields = { systemPrompt: '#lore_agent_system', taskPrompt: '#lore_agent_task' };
    for (const [key, sel] of Object.entries(fields)) {
        $(sel).val(promptText(key)).on('input', function () {
            const v = String($(this).val());
            settings()[key] = v.trim() === PROMPT_FIELDS[key].trim() ? '' : v;
            saveSettingsDebounced();
        });
    }
    $('#lore_agent_reset').on('click', () => {
        for (const [key, sel] of Object.entries(fields)) {
            settings()[key] = '';
            $(sel).val(PROMPT_FIELDS[key]);
        }
        saveSettingsDebounced();
        toastr.success('Prompts reset to default.', 'Lore Agent');
    });
    $('#lore_agent_preview').on('click', () => previewNext().catch(e => toastr.error(escapeHtml(e?.message || e), 'Lore Agent')));
    $('#lore_agent_last').on('click', () => showLastSent().catch(e => toastr.error(escapeHtml(e?.message || e), 'Lore Agent')));
    $('#lore_agent_enabled').prop('checked', s.enabled).on('input', function () { settings().enabled = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#lore_agent_model').val(s.model).on('input', function () { settings().model = String($(this).val()).trim() || DEFAULTS.model; saveSettingsDebounced(); });
    $('#lore_agent_thinking').val(s.thinking).on('change', function () { settings().thinking = String($(this).val()); saveSettingsDebounced(); });
    $('#lore_agent_timeout').val(s.timeoutSec).on('input', function () { settings().timeoutSec = Number($(this).val()) || DEFAULTS.timeoutSec; saveSettingsDebounced(); });
}

jQuery(() => {
    settings();
    renderSettings();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
