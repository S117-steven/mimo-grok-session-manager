'use strict';

let sessions = [];
let grokSessions = [];
let workspaces = [];
let preferences = { sortBy: 'updated-desc', pinnedIds: [], hiddenIds: [], customOrder: [] };
let currentRenameId = null;
let toastTimer = null;
let currentProvider = 'all';
const selectedIds = new Set();

const elements = Object.fromEntries([
    'newSessionButton', 'refreshButton', 'visibleCount', 'totalCount', 'workspaceCount',
    'workspaceFilter', 'sortSelect', 'showHiddenCheckbox', 'sessionCount', 'sessionList',
    'selectionCount', 'selectVisibleButton', 'clearSelectionButton', 'hideSelectedButton',
    'restoreSelectedButton', 'renameModal', 'renameInput', 'saveRenameButton', 'newSessionModal',
    'newDirectoryInput', 'workspaceSuggestions', 'browseFolderButton', 'createSessionButton', 'toast'
].map(id => [id, document.getElementById(id)]));

async function requestJson(url, options) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); } catch { throw new Error('服务器返回了无效响应'); }
    if (!response.ok) throw new Error(data.error?.message || `请求失败 (${response.status})`);
    return data;
}

function postJson(url, body) {
    return requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

function createTextElement(tag, className, text, title) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    if (title) element.title = title;
    return element;
}

function createButton(label, className, handler, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button-small ${className}`;
    button.textContent = label;
    if (title) button.title = title;
    button.addEventListener('click', handler);
    return button;
}

function idSet(values) {
    return new Set(values);
}

function baseSort(items) {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const customPositions = new Map(preferences.customOrder.map((id, index) => [id, index]));
    const compare = {
        'updated-desc': (a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0),
        'updated-asc': (a, b) => (a.timeUpdated || 0) - (b.timeUpdated || 0),
        'title-asc': (a, b) => collator.compare(a.title, b.title),
        'title-desc': (a, b) => collator.compare(b.title, a.title),
        'workspace-asc': (a, b) => collator.compare(a.directory, b.directory) || (b.timeUpdated || 0) - (a.timeUpdated || 0),
        custom: (a, b) => (customPositions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (customPositions.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (b.timeUpdated || 0) - (a.timeUpdated || 0)
    }[preferences.sortBy];
    const pinned = idSet(preferences.pinnedIds);
    return [...items].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || compare(a, b));
}

function getCombinedSessions() {
    const mimoMarked = sessions.map(s => ({ ...s, provider: 'mimo' }));
    const grokMarked = grokSessions.map(s => ({
        ...s,
        provider: 'grok',
        timeUpdated: s.timeUpdated || (s.updatedAt ? new Date(s.updatedAt).getTime() : 0),
        updated: s.updated || s.updatedAt || '-'
    }));
    if (currentProvider === 'grok') return grokMarked;
    if (currentProvider === 'mimo') return mimoMarked;
    return mimoMarked.concat(grokMarked);
}

function displayedSessions() {
    const hidden = idSet(preferences.hiddenIds);
    return baseSort(getCombinedSessions()).filter(session =>
        (!elements.workspaceFilter.value ||
            session.directory.toLowerCase() === elements.workspaceFilter.value.toLowerCase()) &&
        (elements.showHiddenCheckbox.checked || !hidden.has(session.id))
    );
}

function renderWorkspaceOptions() {
    const selectedFilter = elements.workspaceFilter.value;
    elements.workspaceFilter.replaceChildren(new Option('全部工作区', ''));
    elements.workspaceSuggestions.replaceChildren();
    const tags = document.getElementById('workspaceTags');
    if (tags) tags.replaceChildren();
    workspaces.forEach(workspace => {
        const label = `${workspace.directory} (${workspace.sessionCount})`;
        elements.workspaceFilter.append(new Option(label, workspace.directory));
        elements.workspaceSuggestions.append(new Option(workspace.directory, workspace.directory));
        if (tags) {
            const tag = document.createElement('button');
            tag.type = 'button';
            tag.className = 'button button-small button-secondary';
            tag.textContent = workspace.directory;
            tag.title = `${workspace.sessionCount} 个会话`;
            tag.addEventListener('click', () => { elements.newDirectoryInput.value = workspace.directory; });
            tags.append(tag);
        }
    });
    if (workspaces.some(item => item.directory === selectedFilter)) elements.workspaceFilter.value = selectedFilter;
}

function updateSelectionControls() {
    elements.selectionCount.textContent = `已选择 ${selectedIds.size} 项`;
    elements.clearSelectionButton.disabled = selectedIds.size === 0;
    elements.hideSelectedButton.disabled = selectedIds.size === 0;
    elements.restoreSelectedButton.disabled = selectedIds.size === 0;
}

function renderProviderStats() {
    const totalCount = sessions.length + grokSessions.length;
    elements.totalCount.textContent = String(totalCount);
    elements.workspaceCount.textContent = String(workspaces.length);
}

function renderSessions() {
    const visible = displayedSessions();
    const pinned = idSet(preferences.pinnedIds);
    const hidden = idSet(preferences.hiddenIds);
    const knownIds = idSet([...sessions.map(s => s.id), ...grokSessions.map(s => s.id)]);
    const hiddenCount = [...hidden].filter(id => knownIds.has(id)).length;
    elements.sessionList.replaceChildren();
    renderProviderStats();
    elements.visibleCount.textContent = String(visible.filter(item => !hidden.has(item.id)).length);
    elements.sessionCount.textContent = `${visible.length} 项${hiddenCount ? `，已隐藏 ${hiddenCount} 项` : ''}`;

    if (!visible.length) {
        elements.sessionList.append(createTextElement('div', 'message', '当前筛选条件下暂无会话'));
        updateSelectionControls();
        return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((session, index) => {
        const isPinned = pinned.has(session.id);
        const isHidden = hidden.has(session.id);
        const isGrok = session.provider === 'grok';
        const row = document.createElement('div');
        row.className = `session-row${isPinned ? ' pinned' : ''}${isHidden ? ' hidden-session' : ''}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedIds.has(session.id);
        checkbox.setAttribute('aria-label', `选择会话 ${session.title}`);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedIds.add(session.id); else selectedIds.delete(session.id);
            updateSelectionControls();
        });
        row.append(checkbox);
        row.append(createTextElement('span', isPinned ? 'pin-mark' : 'muted', isPinned ? '置顶' : String(index + 1)));

        const titleEl = createTextElement('span', 'title', session.title, session.title);
        if (isGrok) {
            const badge = createTextElement('span', 'provider-badge provider-grok', 'Grok');
            const wrapper = document.createElement('span');
            wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;overflow:hidden';
            wrapper.append(badge);
            wrapper.append(titleEl);
            row.append(wrapper);
        } else {
            row.append(titleEl);
        }

        row.append(createTextElement('span', 'directory', session.directory, session.directory));
        row.append(createTextElement('span', 'updated', session.updated || session.updatedAt || '-'));

        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.append(createButton(isPinned ? '取消置顶' : '置顶', 'button-warning', () => togglePin(session.id)));
        if (preferences.sortBy === 'custom') {
            actions.append(createButton('上移', 'button-secondary', () => moveSession(session.id, -1)));
            actions.append(createButton('下移', 'button-secondary', () => moveSession(session.id, 1)));
        }
        actions.append(createButton('重命名', 'button-secondary', () => openRename(session)));
        actions.append(createButton('继续', 'button-primary', event => {
            if (isGrok) continueGrokSession(session.id, event.currentTarget);
            else continueSession(session.id, event.currentTarget);
        }));
        actions.append(createButton(isHidden ? '恢复' : '隐藏', isHidden ? 'button-secondary' : 'button-danger', () => toggleHidden(session, !isHidden)));
        row.append(actions);
        fragment.append(row);
    });
    elements.sessionList.append(fragment);
    updateSelectionControls();
}

async function loadSessions() {
    elements.refreshButton.disabled = true;
    elements.sessionList.replaceChildren(createTextElement('div', 'message', '正在加载会话...'));
    try {
        const data = await requestJson('/api/sessions');
        sessions = data.sessions;
        grokSessions = data.grokSessions || [];
        const existingIds = idSet([
            ...sessions.map(session => session.id),
            ...grokSessions.map(session => session.id)
        ]);
        [...selectedIds].forEach(id => {
            if (!existingIds.has(id)) selectedIds.delete(id);
        });
        workspaces = data.workspaces;
        preferences = data.preferences;
        elements.sortSelect.value = preferences.sortBy;
        renderWorkspaceOptions();
        renderSessions();
    } catch (error) {
        elements.sessionList.replaceChildren(createTextElement('div', 'message', `加载失败：${error.message}`));
        showToast(error.message, 'error');
    } finally {
        elements.refreshButton.disabled = false;
    }
}

async function savePreferences(changes) {
    const data = await postJson('/api/preferences', changes);
    preferences = data.preferences;
    renderSessions();
}

async function togglePin(id) {
    const pinned = idSet(preferences.pinnedIds);
    if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
    try { await savePreferences({ pinnedIds: [...pinned] }); }
    catch (error) { showToast(error.message, 'error'); }
}

async function moveSession(id, direction) {
    const pinned = idSet(preferences.pinnedIds);
    const current = baseSort(getCombinedSessions()).map(item => item.id);
    const group = displayedSessions()
        .map(item => item.id)
        .filter(itemId => pinned.has(itemId) === pinned.has(id));
    const index = group.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= group.length) return;
    const otherId = group[target];
    const first = current.indexOf(id);
    const second = current.indexOf(otherId);
    [current[first], current[second]] = [current[second], current[first]];
    try { await savePreferences({ customOrder: current }); }
    catch (error) { showToast(error.message, 'error'); }
}

async function toggleHidden(session, hidden) {
    if (hidden && !window.confirm(`隐藏会话"${session.title}"？这不会删除真实会话。`)) return;
    try {
        const data = await postJson('/api/hide', { id: session.id, hidden });
        preferences = data.preferences;
        renderSessions();
        showToast(hidden ? '会话已从列表隐藏' : '会话已恢复显示', 'success');
    } catch (error) { showToast(error.message, 'error'); }
}

async function batchSetHidden(hidden) {
    if (!selectedIds.size) return;
    const action = hidden ? '隐藏' : '恢复';
    if (hidden && !window.confirm(`隐藏选中的 ${selectedIds.size} 个会话？这不会删除真实会话。`)) return;
    try {
        const data = await postJson('/api/hide-batch', { ids: [...selectedIds], hidden });
        preferences = data.preferences;
        selectedIds.clear();
        renderSessions();
        showToast(`已${action} ${data.affected} 个会话`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
}

function openRename(session) {
    currentRenameId = session.id;
    elements.renameInput.value = session.title;
    openModal(elements.renameModal);
    elements.renameInput.select();
}

function openModal(modal) {
    modal.classList.add('active');
    const control = modal.querySelector('input, select');
    if (control) control.focus();
}

function closeModal(modal) {
    modal.classList.remove('active');
    if (modal === elements.renameModal) currentRenameId = null;
}

async function saveRename() {
    const title = elements.renameInput.value.trim();
    if (!title) return showToast('请输入标题', 'error');
    elements.saveRenameButton.disabled = true;
    try {
        await postJson('/api/rename', { id: currentRenameId, title });
        closeModal(elements.renameModal);
        showToast('重命名成功', 'success');
        await loadSessions();
    } catch (error) { showToast(error.message, 'error'); }
    finally { elements.saveRenameButton.disabled = false; }
}

async function continueSession(id, button) {
    button.disabled = true;
    try {
        await postJson('/api/continue', { id });
        showToast('已打开会话终端', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
}

async function continueGrokSession(id, button) {
    button.disabled = true;
    try {
        await postJson('/api/continue-grok', { id });
        showToast('已打开 Grok 会话', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
}

let currentBrowsePath = '';

async function browseFolders(dir) {
    const browser = document.getElementById('folderBrowser');
    const pathEl = document.getElementById('folderBrowserPath');
    const listEl = document.getElementById('folderBrowserList');
    browser.style.display = 'block';
    pathEl.textContent = dir || '(选择驱动器)';
    listEl.innerHTML = '<div style="padding:12px;color:#7a858d">加载中...</div>';
    try {
        const data = await postJson('/api/browse-folders', { path: dir });
        currentBrowsePath = data.path;
        listEl.replaceChildren();
        if (data.path) {
            const parent = data.path.replace(/[\\\/][^\\\/]+[\\\/]?$/, '') || '';
            const upItem = document.createElement('div');
            upItem.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;color:#00a846';
            upItem.textContent = '.. (上级目录)';
            upItem.addEventListener('click', () => browseFolders(parent));
            listEl.append(upItem);
        }
        data.entries.forEach(name => {
            const fullPath = data.path ? `${data.path}\\${name}` : name;
            const item = document.createElement('div');
            item.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px';
            item.textContent = name;
            item.addEventListener('click', () => {
                if (data.path) {
                    elements.newDirectoryInput.value = fullPath;
                    browseFolders(fullPath);
                } else {
                    browseFolders(name);
                }
            });
            item.addEventListener('dblclick', () => {
                elements.newDirectoryInput.value = fullPath;
                browser.style.display = 'none';
            });
            listEl.append(item);
        });
        if (!data.entries.length) {
            listEl.innerHTML = '<div style="padding:12px;color:#7a858d">此文件夹为空</div>';
        }
    } catch (error) {
        listEl.innerHTML = `<div style="padding:12px;color:#c63838">${error.message}</div>`;
    }
}

async function createSession() {
    const directory = elements.newDirectoryInput.value.trim();
    if (!directory) return showToast('请选择或输入本地文件夹', 'error');
    elements.createSessionButton.disabled = true;
    try {
        await postJson('/api/new', { directory });
        closeModal(elements.newSessionModal);
        showToast('已在所选工作区打开新对话终端', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { elements.createSessionButton.disabled = false; }
}

async function createGrokSession() {
    const directory = elements.newDirectoryInput.value.trim();
    if (!directory) return showToast('请选择或输入本地文件夹', 'error');
    elements.createGrokSessionButton.disabled = true;
    try {
        await postJson('/api/new-grok', { directory });
        closeModal(elements.newSessionModal);
        showToast('已在所选工作区打开 Grok 对话', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { elements.createGrokSessionButton.disabled = false; }
}

function showToast(message, type) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast ${type || ''} show`;
    toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3000);
}

function setProvider(provider) {
    currentProvider = provider;
    document.querySelectorAll('.provider-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.provider === provider);
    });
    selectedIds.clear();
    renderSessions();
}

elements.refreshButton.addEventListener('click', loadSessions);
elements.newSessionButton.addEventListener('click', () => {
    if (!elements.newDirectoryInput.value) {
        elements.newDirectoryInput.value = elements.workspaceFilter.value || workspaces[0]?.directory || '';
    }
    openModal(elements.newSessionModal);
});
elements.createSessionButton.addEventListener('click', createSession);
elements.createGrokSessionButton = document.getElementById('createGrokSessionButton');
elements.createGrokSessionButton.addEventListener('click', createGrokSession);
document.getElementById('browseServerButton').addEventListener('click', () => browseFolders(''));
elements.selectVisibleButton.addEventListener('click', () => {
    displayedSessions().forEach(session => selectedIds.add(session.id));
    renderSessions();
});
elements.clearSelectionButton.addEventListener('click', () => {
    selectedIds.clear();
    renderSessions();
});
elements.hideSelectedButton.addEventListener('click', () => batchSetHidden(true));
elements.restoreSelectedButton.addEventListener('click', () => batchSetHidden(false));
elements.saveRenameButton.addEventListener('click', saveRename);
elements.workspaceFilter.addEventListener('change', renderSessions);
elements.showHiddenCheckbox.addEventListener('change', renderSessions);
elements.sortSelect.addEventListener('change', async event => {
    try {
        const changes = { sortBy: event.target.value };
        if (event.target.value === 'custom' && preferences.customOrder.length === 0) {
            const hidden = idSet(preferences.hiddenIds);
            changes.customOrder = baseSort(getCombinedSessions()).filter(item => !hidden.has(item.id)).map(item => item.id);
        }
        await savePreferences(changes);
    } catch (error) {
        elements.sortSelect.value = preferences.sortBy;
        showToast(error.message, 'error');
    }
});
elements.renameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveRename();
});
elements.newDirectoryInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') createSession();
});
document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => closeModal(document.getElementById(button.dataset.closeModal)));
});
document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal(modal);
    });
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(closeModal);
});
document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', () => setProvider(tab.dataset.provider));
});

loadSessions();
