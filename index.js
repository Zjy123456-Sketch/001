import { isChatSaving, isGenerating } from '../../../../script.js';
import { CACHE_KEY, PLOT_LOG, createAnalyzer } from './optimizer.js';

const analyze = createAnalyzer();
const dialog = document.createElement('dialog');
dialog.id = 'st-chat-optimizer';
dialog.setAttribute('aria-labelledby', 'st-chat-optimizer-title');
dialog.innerHTML = [
    '<header class="sco-header">',
    '<h2 id="st-chat-optimizer-title">聊天记录瘦身</h2>',
    '<button type="button" class="sco-close" aria-label="关闭">×</button>',
    '</header>',
    '<p class="sco-status" data-status role="status"></p>',
    '<progress data-progress max="100" aria-label="分析进度" hidden></progress>',
    '<section data-result aria-label="分析结果" hidden>',
    '<dl class="sco-metrics"><div><dt>原始体积</dt><dd data-before></dd></div>',
    '<div><dt>优化后</dt><dd data-after></dd></div>',
    '<div><dt data-saved-label>可减少</dt><dd data-saved></dd></div></dl>',
    '<p class="sco-status" data-summary></p>',
    '<ul class="sco-chart" data-chart aria-label="原存档体积构成"></ul>',
    '<p class="sco-status" data-note hidden></p>',
    '</section>',
    '<div class="sco-actions">',
    '<button type="button" class="sco-primary" data-apply hidden>优化当前聊天</button>',
    '<button type="button" data-current>重新分析</button>',
    '</div>',
    '<p class="sco-status" data-save-status role="status" hidden></p>',
].join('');

const ui = selector => dialog.querySelector(selector);
const closeButton = ui('.sco-close');
const currentButton = ui('[data-current]');
const applyButton = ui('[data-apply]');
const progress = ui('[data-progress]');
const resultSection = ui('[data-result]');
const status = ui('[data-status]');
const saveStatus = ui('[data-save-status]');
let generation = 0;
let worker;
let currentPlan;
let saving = false;

function openDialog() {
    if (!dialog.isConnected) document.body.append(dialog);
    if (dialog.open) return;
    dialog.showModal();
    startAnalysis();
}

function sizeText(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(2) + ' KiB';
    return (bytes / 1024 ** 2).toFixed(2) + ' MiB';
}

function stopWorker() {
    worker?.terminate();
    worker = null;
}

function getTarget(context) {
    const id = context?.getCurrentChatId?.() ?? context?.chatId;
    if (id == null || id === '') return null;
    if (context.groupId) return { id, group: context.groupId };
    const avatar = context.characters?.[context.characterId]?.avatar;
    return avatar ? { id, avatar } : null;
}

function sameTarget(previous, current) {
    return current && previous.id === current.id && previous.avatar === current.avatar && previous.group === current.group;
}

function startAnalysis() {
    stopWorker();
    currentPlan = null;
    resultSection.hidden = true;
    applyButton.hidden = true;
    saveStatus.hidden = true;
    status.classList.remove('sco-error');
    progress.value = 0;
    progress.hidden = false;
    const job = ++generation;

    try {
        const context = globalThis.SillyTavern?.getContext();
        const target = getTarget(context);
        if (!target || !context.chat?.length) throw new Error('请先打开一份聊天。');
        if (isGenerating()) throw new Error('等当前回复生成完成后，再点「重新分析」。');

        const serializedMetadata = JSON.stringify(context.chatMetadata || {});
        const header = '{"chat_metadata":' + serializedMetadata + ',"user_name":"unused","character_name":"unused"}';
        const chunks = [header];
        for (const message of context.chat) chunks.push('\n', JSON.stringify(message));
        status.textContent = '正在分析当前聊天 · ' + target.id;
        analyzeChat(new Blob(chunks), { target, serializedMetadata }, job);
    } catch (error) {
        finishAnalysis(job, null, error.message);
    }
}

function finishAnalysis(job, data, error) {
    if (job !== generation) return;
    stopWorker();
    progress.hidden = true;
    if (error) {
        status.textContent = error;
        status.classList.add('sco-error');
        return;
    }
    showResult(data.capture, data.result);
}

function analyzeChat(file, capture, job) {
    const update = value => {
        if (job === generation) progress.value = value;
    };
    const finish = (result, error) => finishAnalysis(job, { result, capture }, error);
    const fallback = () => {
        analyze(file, update)
            .then(result => finish(result), error => finish(null, error.message || '读取聊天失败。'));
    };
    try {
        worker = new Worker(new URL('./optimizer-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            if (typeof data.progress === 'number') update(data.progress);
            else finish(data.result, data.error);
        };
        worker.onerror = event => {
            event.preventDefault();
            if (job !== generation) return;
            stopWorker();
            fallback();
        };
        worker.postMessage(file);
    } catch {
        stopWorker();
        fallback();
    }
}

function showResult(capture, { stats, afterBytes, floors, message, analysisOnly }) {
    status.textContent = '当前聊天 · ' + capture.target.id;
    ui('[data-before]').textContent = sizeText(stats.bytes);
    ui('[data-after]').textContent = sizeText(afterBytes);
    ui('[data-saved-label]').textContent = '可减少';
    ui('[data-saved]').textContent = (100 * (stats.bytes - afterBytes) / stats.bytes).toFixed(2) + '%';
    ui('[data-summary]').textContent = floors.length
        ? '可清理 ' + floors.length + ' 份重复缓存，保留全部 ' + stats.messages + ' 条消息及 ' + stats.snapshots + ' 个快照索引。'
        : stats.messages + ' 条消息。' + (analysisOnly ? '仅提供体积分析。' : '') + message;

    const buckets = [
        ['小白盒变量快照', stats.sizes.snapshots],
        ['消息内容', stats.sizes.mes],
        ['候选回复', stats.sizes.swipes],
        ['思考文本', stats.sizes.reasoning],
        ['消息变量', stats.sizes.variables],
        ['其他字段和格式开销', stats.sizes.other],
    ];
    const items = [];
    for (const [label, bytes] of buckets.sort((a, b) => b[1] - a[1])) {
        if (!bytes) continue;
        const ratio = 100 * bytes / stats.bytes;
        const item = document.createElement('li');
        const labelRow = document.createElement('div');
        const number = document.createElement('span');
        const bar = document.createElement('progress');
        labelRow.append(label, number);
        number.textContent = sizeText(bytes) + ' · ' + ratio.toFixed(2) + '%';
        bar.max = 100;
        bar.value = ratio;
        bar.setAttribute('aria-hidden', 'true');
        item.append(labelRow, bar);
        items.push(item);
    }
    ui('[data-chart]').replaceChildren(...items);

    const note = ui('[data-note]');
    note.textContent = stats.snapshotCache ? '原档快照中的「压缩相邻消息」共占 ' + sizeText(stats.snapshotCache) + '。' : '';
    note.hidden = !stats.snapshotCache;
    if (floors.length) currentPlan = { ...capture, floors, messageCount: stats.messages, snapshotCount: stats.snapshots };
    applyButton.hidden = !currentPlan;
    resultSection.hidden = false;
}

function reportSave(message, error = false) {
    saveStatus.hidden = false;
    saveStatus.textContent = message;
    saveStatus.classList.toggle('sco-error', error);
}

async function readSavedChat(context, target) {
    const path = target.group ? '/api/chats/group/get' : '/api/chats/get';
    const body = target.group ? { id: target.id } : { avatar_url: target.avatar, file_name: target.id };
    const response = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('酒馆返回 HTTP ' + response.status + '。');
    return response.json();
}

function checkSavedChat(records, plan, metadata, snapshotMap) {
    const saved = records?.[0]?.chat_metadata;
    const savedMap = saved?.LWB_SNAP;
    return Array.isArray(records)
        && records.length === plan.messageCount + 1
        && saved?.integrity === metadata.integrity
        && savedMap
        && Object.keys(savedMap).length === plan.snapshotCount
        && plan.floors.every(id => savedMap[id]?.vars && !Object.hasOwn(savedMap[id].vars, CACHE_KEY))
        && JSON.stringify(savedMap) === JSON.stringify(snapshotMap)
        && JSON.stringify(saved.variables) === JSON.stringify(metadata.variables);
}

async function applyOptimization() {
    if (!currentPlan || saving) return;
    if (isGenerating() || isChatSaving) {
        reportSave('酒馆正在生成或保存。等它完成后再优化。', true);
        return;
    }
    const context = globalThis.SillyTavern?.getContext();
    const metadata = context?.chatMetadata;
    const plan = currentPlan;
    if (!sameTarget(plan.target, getTarget(context))
        || context.chat.length !== plan.messageCount
        || context.chat.some(message => PLOT_LOG.test(message.mes))
        || JSON.stringify(metadata) !== plan.serializedMetadata) {
        startAnalysis();
        reportSave('聊天状态有更新，已重新分析。请确认新的结果。', true);
        return;
    }

    const snapshotMap = metadata.LWB_SNAP;
    const changes = plan.floors.map(id => {
        const before = snapshotMap[id];
        const vars = { ...before.vars };
        delete vars[CACHE_KEY];
        return { id, before, after: { ...before, vars } };
    });
    plan.serializedMetadata = null;
    currentPlan = null;
    saving = true;
    closeButton.disabled = currentButton.disabled = applyButton.disabled = true;
    reportSave('正在保存并校验当前聊天…');
    try {
        for (const { id, after } of changes) snapshotMap[id] = after;
        await context.saveChat();
        const records = await readSavedChat(context, plan.target);
        if (!checkSavedChat(records, plan, metadata, snapshotMap)) throw new Error('磁盘校验未通过。');
        ui('[data-saved-label]').textContent = '已减少';
        ui('[data-summary]').textContent = '已清理 ' + changes.length + ' 份重复缓存，保留全部 ' + plan.messageCount + ' 条消息及 ' + plan.snapshotCount + ' 个快照索引。';
        reportSave('已保存到当前聊天，可以继续聊了。');
    } catch (error) {
        for (const { id, before, after } of changes) {
            if (snapshotMap[id] === after) snapshotMap[id] = before;
        }
        reportSave('未能确认保存。已恢复本页缓存，请重新分析。' + (error.message || ''), true);
    } finally {
        saving = false;
        applyButton.hidden = true;
        closeButton.disabled = currentButton.disabled = applyButton.disabled = false;
    }
}

closeButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => {
    if (saving) event.preventDefault();
});
dialog.addEventListener('close', () => {
    ++generation;
    currentPlan = null;
    stopWorker();
});
currentButton.addEventListener('click', startAnalysis);
applyButton.addEventListener('click', applyOptimization);

function mount() {
    const settings = document.querySelector('#extensions_settings2, #extensions_settings');
    if (settings && !document.querySelector('#st-chat-optimizer-settings')) {
        const button = document.createElement('button');
        button.id = 'st-chat-optimizer-settings';
        button.className = 'menu_button';
        button.type = 'button';
        button.textContent = '聊天记录瘦身';
        button.addEventListener('click', openDialog);
        settings.append(button);
    }
    const menu = document.querySelector('#extensionsMenu');
    if (menu && !document.querySelector('#st-chat-optimizer-menu')) {
        const entry = document.createElement('div');
        entry.id = 'st-chat-optimizer-menu';
        entry.className = 'list-group-item flex-container flexGap5 interactable';
        entry.tabIndex = 0;
        entry.setAttribute('role', 'button');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-file-zipper';
        icon.setAttribute('aria-hidden', 'true');
        entry.append(icon, ' 聊天记录瘦身');
        entry.addEventListener('click', openDialog);
        entry.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openDialog();
            }
        });
        menu.append(entry);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
const { eventSource, eventTypes } = globalThis.SillyTavern?.getContext() ?? {};
if (eventTypes?.APP_INITIALIZED) eventSource?.once(eventTypes.APP_INITIALIZED, mount);
