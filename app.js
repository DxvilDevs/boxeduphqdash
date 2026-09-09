(() => {
  'use strict';

  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  const config = window.BOXED_UP_CONFIG || {};
  const supabaseKey = config.SUPABASE_KEY || config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
  const OWNER_EMAIL = 'dxvil6354@gmail.com';
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  const STATUS = ['Backlog', 'Ready', 'In progress', 'Review', 'Testing', 'Approved', 'Shipped'];
  const COMPLETE_STATUSES = new Set(['Approved', 'Shipped']);
  const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
  const EFFORTS = ['Small', 'Medium', 'Large'];
  const EFFORT_WEIGHT = { Small: 1, Medium: 2, Large: 4 };
  const STATUS_PROGRESS = { Backlog: 0, Ready: 10, 'In progress': 35, Review: 60, Testing: 78, Approved: 100, Shipped: 100 };
  const ROLE_PERMISSIONS = [
    ['items.create', 'Create tasks', 'Add new tasks/issues/projects'],
    ['items.edit', 'Edit tasks', 'Edit fields, workflow status and move cards'],
    ['items.approve', 'Approve tasks', 'Move reviewed work into Approved'],
    ['items.delete', 'Delete tasks', 'Permanently delete tasks'],
    ['trackers.create', 'Create trackers', 'Add new databases / boards'],
    ['trackers.edit', 'Edit trackers', 'Rename, reorder and change tracker views'],
    ['trackers.delete', 'Delete trackers', 'Delete a tracker and its tasks'],
    ['updates.ship', 'Ship updates', 'Control Ship Room release stages and mark updates live'],
    ['members.invite', 'Invite members', 'Create/revoke team invite links'],
    ['members.manage', 'Manage members', 'Change member roles and remove members'],
    ['workspace.manage', 'Workspace settings', 'Rename/manage workspace settings']
  ];

  const state = {
    db: null,
    session: null,
    user: null,
    workspaces: [],
    workspace: null,
    members: [],
    roles: [],
    profiles: new Map(),
    trackers: [],
    items: [],
    activity: [],
    activityAvailable: true,
    invites: [],
    presence: new Map(),
    route: 'home',
    viewOverrides: {},
    tableFilter: {},
    realtime: null,
    reloadTimer: null,
    authMode: 'login',
    swRegistration: null,
    installPrompt: null,
    reminderTimer: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(value = '') {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function initials(nameOrEmail = '?') {
    const cleaned = String(nameOrEmail).trim();
    if (!cleaned) return '?';
    const base = cleaned.includes('@') ? cleaned.split('@')[0] : cleaned;
    const words = base.split(/[\s._-]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : base.slice(0, 2)).toUpperCase();
  }

  function toast(message, type = 'normal') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`;
    el.textContent = message;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  function iconForRole(role) {
    return role === 'owner' ? '👑' : role === 'admin' ? '🛡️' : role === 'developer' ? '🛠️' : '👁️';
  }

  function roleForKey(roleKey) {
    return state.roles.find(r => r.role_key === roleKey) || null;
  }

  function roleLabel(roleKey) {
    return roleForKey(roleKey)?.name || roleKey || 'Viewer';
  }

  function roleClass(roleKey) {
    const color = roleForKey(roleKey)?.color;
    if (['yellow','red','blue','green','purple','pink','gray'].includes(color)) return color;
    return roleKey === 'owner' ? 'yellow' : roleKey === 'admin' ? 'red' : roleKey === 'developer' ? 'blue' : 'gray';
  }

  function brandLogoHTML(cls = 'brand-logo') {
    return `<span class="${cls}"><img src="./assets/logo.png" alt=""></span>`;
  }

  function statusClass(status) {
    if (status === 'In progress') return 'blue';
    if (status === 'Review' || status === 'Testing') return 'purple';
    if (status === 'Approved' || status === 'Shipped') return 'green';
    if (status === 'Ready') return 'yellow';
    return 'gray';
  }

  function priorityClass(priority) {
    return priority === 'Urgent' || priority === 'High' ? 'red' : priority === 'Medium' ? 'yellow' : 'green';
  }

  function effortClass(effort) {
    return effort === 'Large' ? 'red' : effort === 'Medium' ? 'yellow' : 'green';
  }

  function typeClass(type = '') {
    const s = String(type).toLowerCase();
    if (s.includes('event')) return 'blue';
    if (s.includes('polish')) return 'pink';
    if (s.includes('map')) return 'gray';
    if (s.includes('vehicle')) return 'red';
    if (s.includes('script')) return 'purple';
    return 'purple';
  }

  function pill(value, cls = 'gray', noDot = true) {
    if (!value) return '<span class="empty-cell">—</span>';
    return `<span class="pill ${cls} ${noDot ? 'no-dot' : ''}">${esc(value)}</span>`;
  }

  function formatDate(value, withTime = false) {
    if (!value) return '—';
    const d = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', withTime
      ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', year: 'numeric' }
    ).format(d);
  }

  function daysOpen(createdAt, status) {
    if (!createdAt) return '—';
    if (COMPLETE_STATUSES.has(status)) return 'Closed';
    const diff = Date.now() - new Date(createdAt).getTime();
    return `${Math.max(0, Math.floor(diff / 86400000))}d`;
  }

  function memberFor(id) {
    if (!id) return null;
    const member = state.members.find(m => m.user_id === id);
    const profile = state.profiles.get(id);
    return member ? { ...member, profile } : null;
  }

  function displayName(id) {
    const p = state.profiles.get(id);
    return p?.display_name || p?.email || 'Team member';
  }

  function avatarHTML(id, size = 'sm') {
    const p = state.profiles.get(id);
    const label = p?.display_name || p?.email || 'Member';
    if (p?.avatar_url) {
      return `<span class="avatar ${size}"><img src="${esc(p.avatar_url)}" alt=""></span>`;
    }
    return `<span class="avatar ${size}" title="${esc(label)}">${esc(initials(label))}</span>`;
  }

  function myRole() {
    return state.members.find(m => m.user_id === state.user?.id)?.role || 'viewer';
  }

  function hasPermission(permission) {
    if (myRole() === 'owner') return true;
    const permissions = roleForKey(myRole())?.permissions || {};
    return permissions[permission] === true;
  }

  function canCreateItems() { return hasPermission('items.create'); }
  function canEditItems() { return hasPermission('items.edit'); }
  function canDeleteItems() { return hasPermission('items.delete'); }
  function canCreateTrackers() { return hasPermission('trackers.create'); }
  function canEditTrackers() { return hasPermission('trackers.edit'); }
  function canDeleteTrackers() { return hasPermission('trackers.delete'); }
  function canInviteMembers() { return hasPermission('members.invite'); }
  function canManageMembers() { return hasPermission('members.manage'); }
  function canEdit() { return canCreateItems() || canEditItems(); }
  function isOwner() { return myRole() === 'owner'; }
  function canApproveItems() { return hasPermission('items.approve'); }
  function canShipUpdates() { return hasPermission('updates.ship'); }

  function isComplete(item) {
    return Boolean(item && COMPLETE_STATUSES.has(item.status));
  }

  function daysUntil(dateValue) {
    if (!dateValue) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    return Math.round((target - today) / 86400000);
  }

  function trackerFor(id) {
    return state.trackers.find(t => t.id === id) || null;
  }

  function dependencyIds(item) {
    return Array.isArray(item?.custom_data?.blocked_by) ? item.custom_data.blocked_by.filter(Boolean) : [];
  }

  function blockedByItems(item) {
    return dependencyIds(item)
      .map(id => state.items.find(candidate => candidate.id === id))
      .filter(dep => dep && !isComplete(dep));
  }

  function isBlocked(item) {
    return blockedByItems(item).length > 0;
  }

  function currentUpdateTracker() {
    return state.trackers.find(t => t.settings?.isCurrentUpdate === true)
      || state.trackers.find(t => /weekly update/i.test(t.name))
      || null;
  }

  function currentUpdateItems() {
    const tracker = currentUpdateTracker();
    return tracker ? state.items.filter(item => item.tracker_id === tracker.id) : [];
  }

  function currentReleaseDate() {
    const tracker = currentUpdateTracker();
    if (!tracker) return null;
    if (tracker.settings?.releaseDate) return tracker.settings.releaseDate;
    const dated = currentUpdateItems().map(item => item.due_date).filter(Boolean).sort();
    if (!dated.length) return null;
    const d = new Date(`${dated[dated.length - 1]}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function updateTitle() {
    const tracker = currentUpdateTracker();
    return tracker?.settings?.updateTitle || tracker?.name || 'Current Update';
  }

  function workflowProgress(item) {
    return STATUS_PROGRESS[item?.status] ?? Math.max(0, Math.min(100, Number(item?.progress || 0)));
  }

  function allowedStatuses(current = '') {
    return STATUS.filter(status => {
      if (status === current) return true;
      if (status === 'Approved' && !canApproveItems()) return false;
      if (status === 'Shipped' && !canShipUpdates()) return false;
      return true;
    });
  }

  function dueLabel(item) {
    if (!item?.due_date) return 'No due date';
    const days = daysUntil(item.due_date);
    if (days === null) return formatDate(item.due_date);
    if (days < 0) return `${Math.abs(days)}d overdue`;
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    return `Due in ${days}d`;
  }

  function categoryForItem(item) {
    const value = `${item?.item_type || ''} ${item?.title || ''}`.toLowerCase();
    if (/vehicle|kart|car|formula/.test(value)) return 'Vehicles';
    if (/map|zone|world|environment/.test(value)) return 'Map';
    if (/script|code|admin|datastore|system/.test(value)) return 'Scripting';
    if (/ui|ux|image|graphic|polish|thumbnail|icon/.test(value)) return 'Art & UI';
    if (/test|qa|playtest/.test(value)) return 'Testing';
    if (/event|market|announce|discord|social/.test(value)) return 'Events & Marketing';
    return 'Other';
  }

  function updateReadiness(items = currentUpdateItems()) {
    if (!items.length) return 0;
    return Math.round(items.reduce((sum, item) => sum + workflowProgress(item), 0) / items.length);
  }

  function onlineMemberIds() {
    return new Set([...state.presence.keys()]);
  }

  function isOnline(userId) {
    return onlineMemberIds().has(userId);
  }

  function activityActor(entry) {
    if (!entry?.actor_id) return 'System';
    return displayName(entry.actor_id);
  }

  function notificationStorageKey() {
    return `boxed-up-notification-read:${state.workspace?.id || 'none'}:${state.user?.id || 'none'}`;
  }

  function readNotificationIds() {
    try {
      return new Set(JSON.parse(localStorage.getItem(notificationStorageKey()) || '[]'));
    } catch (_) {
      return new Set();
    }
  }

  function saveReadNotificationIds(set) {
    localStorage.setItem(notificationStorageKey(), JSON.stringify([...set].slice(-500)));
  }

  function markNotificationRead(id) {
    const read = readNotificationIds();
    read.add(id);
    saveReadNotificationIds(read);
  }

  function buildNotifications() {
    if (!state.user) return [];
    const notices = [];
    const now = Date.now();
    const myTasks = state.items.filter(item => item.assignee_id === state.user.id && !isComplete(item));
    myTasks.forEach(item => {
      const days = daysUntil(item.due_date);
      if (days !== null && days <= 3) {
        notices.push({
          id: `due:${item.id}:${item.due_date}:${days < 0 ? 'overdue' : days}`,
          kind: days < 0 ? 'danger' : days <= 1 ? 'warning' : 'info',
          icon: days < 0 ? '🚨' : '⏰',
          title: item.title,
          body: dueLabel(item),
          item_id: item.id,
          at: item.due_date ? new Date(`${item.due_date}T12:00:00`).getTime() : now
        });
      }
      const blockers = blockedByItems(item);
      if (blockers.length) {
        notices.push({
          id: `blocked:${item.id}:${blockers.map(b => b.id).sort().join(',')}`,
          kind: 'danger',
          icon: '🔒',
          title: `${item.title} is blocked`,
          body: `Waiting on ${blockers.map(b => b.title).join(', ')}`,
          item_id: item.id,
          at: now - 1
        });
      }
    });

    if (canApproveItems()) {
      state.items.filter(item => item.status === 'Review').forEach(item => {
        notices.push({
          id: `review:${item.id}:${item.updated_at || ''}`,
          kind: 'info',
          icon: '👀',
          title: `${item.title} is ready for review`,
          body: trackerFor(item.tracker_id)?.name || 'Task',
          item_id: item.id,
          at: new Date(item.updated_at || item.created_at || now).getTime()
        });
      });
    }

    state.activity.slice(0, 80).forEach(entry => {
      if (!entry.entity_id || entry.actor_id === state.user.id) return;
      const item = state.items.find(candidate => candidate.id === entry.entity_id);
      if (!item || item.assignee_id !== state.user.id) return;
      notices.push({
        id: `activity:${entry.id}`,
        kind: 'info',
        icon: '📡',
        title: `${activityActor(entry)} updated ${entry.entity_title || item.title}`,
        body: activityDescription(entry, false),
        item_id: item.id,
        at: new Date(entry.created_at).getTime()
      });
    });

    const rank = { danger: 0, warning: 1, info: 2 };
    return notices.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.at - a.at).slice(0, 100);
  }

  function unreadNotificationCount() {
    const read = readNotificationIds();
    return buildNotifications().filter(n => !read.has(n.id)).length;
  }

  function configured() {
    return config.SUPABASE_URL && supabaseKey &&
      !String(config.SUPABASE_URL).includes('YOUR_PROJECT') &&
      !String(supabaseKey).includes('YOUR_KEY');
  }

  function notificationState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  async function registerPwa() {
    if (!('serviceWorker' in navigator)) return;
    try {
      state.swRegistration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        state.installPrompt = event;
        document.body.classList.add('can-install');
      });
      window.addEventListener('appinstalled', () => {
        state.installPrompt = null;
        document.body.classList.remove('can-install');
        toast('Boxed Up HQ installed.');
      });
      if (notificationState() === 'granted') await registerPeriodicReminders();
    } catch (err) {
      console.warn('PWA registration failed', err);
    }
  }

  async function registerPeriodicReminders() {
    const registration = state.swRegistration || await navigator.serviceWorker.ready;
    if (!registration || !('periodicSync' in registration)) return;
    try {
      let allowed = true;
      if (navigator.permissions?.query) {
        const permission = await navigator.permissions.query({ name: 'periodic-background-sync' });
        allowed = permission.state !== 'denied';
      }
      if (allowed) {
        await registration.periodicSync.register('boxed-up-due-reminders', { minInterval: 6 * 60 * 60 * 1000 });
      }
    } catch (err) {
      console.debug('Periodic background reminders are unavailable in this browser.', err);
    }
  }

  async function requestNotifications() {
    if (!('Notification' in window)) {
      toast('This browser does not support notifications.', 'error');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications were not enabled.', 'error');
      return;
    }
    toast('Task due-date reminders enabled.');
    await registerPeriodicReminders();
    await syncReminderTasks();
    if (state.workspace) renderShell();
    else renderPage();
  }

  async function installPwa() {
    if (!state.installPrompt) {
      toast("Use your browser\'s Install app / Add to Home Screen option.");
      return;
    }
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    document.body.classList.remove('can-install');
  }

  function reminderTasks() {
    if (!state.user || !state.workspace) return [];
    const trackerMap = new Map(state.trackers.map(t => [t.id, t]));
    return state.items
      .filter(item => item.assignee_id === state.user.id && !isComplete(item) && item.due_date)
      .map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
        due_date: item.due_date,
        tracker_name: trackerMap.get(item.tracker_id)?.name || '',
        workspace_name: state.workspace.name,
        url: `./#tracker/${item.tracker_id}`
      }));
  }

  async function syncReminderTasks() {
    if (!state.swRegistration || notificationState() !== 'granted') return;
    const worker = state.swRegistration.active || state.swRegistration.waiting || state.swRegistration.installing;
    worker?.postMessage({ type: 'SYNC_REMINDER_TASKS', tasks: reminderTasks() });
  }

  async function clearReminderTasks() {
    if (!state.swRegistration) return;
    const worker = state.swRegistration.active || state.swRegistration.waiting || state.swRegistration.installing;
    worker?.postMessage({ type: 'SYNC_REMINDER_TASKS', tasks: [] });
  }

  function nextDueSummary() {
    const tasks = reminderTasks().slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    if (!tasks.length) return null;
    const task = tasks[0];
    const today = new Date(); today.setHours(0,0,0,0);
    const due = new Date(`${task.due_date}T00:00:00`);
    const days = Math.round((due - today) / 86400000);
    return { ...task, days };
  }

  function startReminderLoop() {
    clearInterval(state.reminderTimer);
    state.reminderTimer = setInterval(() => syncReminderTasks().catch(console.error), 30 * 60 * 1000);
  }

  async function init() {
    registerPwa();
    if (!configured()) {
      renderSetup();
      return;
    }

    try {
      state.db = window.supabase.createClient(config.SUPABASE_URL, supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await state.db.auth.getSession();
      if (error) throw error;
      state.session = data.session;
      state.user = data.session?.user || null;

      state.db.auth.onAuthStateChange((_event, session) => {
        state.session = session;
        state.user = session?.user || null;
        if (!state.user) clearReminderTasks().catch(console.error);
        setTimeout(() => state.user ? bootUser() : renderAuth(), 0);
      });

      if (state.user) await bootUser();
      else renderAuth();
    } catch (err) {
      renderFatal(err);
    }
  }

  function renderSetup() {
    app.innerHTML = `
      <div class="setup-shell">
        <div class="setup-card">
          ${brandLogoHTML('brand-mark brand-image')}
          <h1>Boxed Up HQ is ready to connect.</h1>
          <p>This build is designed for GitHub Pages + Supabase. The front end is already complete; you just need to connect your free database project.</p>
          <ol class="setup-steps">
            <li>Create a Supabase project.</li>
            <li>Open <strong>SQL Editor</strong> and run <code>supabase/schema.sql</code>.</li>
            <li>Add <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> as GitHub Actions repository secrets.</li>
            <li>Set GitHub Pages to <strong>GitHub Actions</strong>, then push to <code>main</code>.</li>
          </ol>
          <div class="info-box">Do not paste a <strong>service_role</strong> or secret key into the website. This project is built to use browser-safe credentials plus Row Level Security.</div>
          <p class="help">GitHub Actions generates <code>config.js</code> only inside the deployment artifact. Full steps are in README.md.</p>
        </div>
      </div>`;
  }

  function renderFatal(err) {
    app.innerHTML = `
      <div class="setup-shell"><div class="setup-card">
        <h1>Couldn’t start Boxed Up HQ</h1>
        <div class="error-box">${esc(err?.message || String(err))}</div>
        <p>Check <code>config.js</code>, then make sure you ran <code>supabase/schema.sql</code>.</p>
      </div></div>`;
  }

  function renderAuth(message = '') {
    const invited = inviteToken ? `<div class="info-box">You’ve been invited to a Boxed Up workspace. Sign in with the email the invite was sent to.</div>` : '';
    app.innerHTML = `
      <div class="auth-shell">
        <section class="auth-art">
          <div class="auth-brand">${brandLogoHTML('brand-mark brand-image')}<span>BOXED UP HQ</span></div>
          <div>
            <h1>Build it. Track it. Ship it.</h1>
            <p>A Boxed Up Games production HQ with Notion-clean databases, Trello-style boards and live team collaboration.</p>
            <div class="preview-card">
              <div class="preview-row"><strong>F1 Vehicles</strong>${pill('Medium','yellow')}${pill('🚗 Vehicle','red')}</div>
              <div class="preview-row"><strong>F1 Zone</strong>${pill('High','red')}${pill('🔧 Map','gray')}</div>
              <div class="preview-row"><strong>Admin panel</strong>${pill('In progress','blue')}${pill('💻 Script','purple')}</div>
            </div>
          </div>
          <span class="help">Built for Boxed Up Games • collaborative • realtime</span>
        </section>
        <section class="auth-panel">
          <div class="auth-card">
            <h2>Welcome to the team.</h2>
            <p>Sign in to open Boxed Up HQ.</p>
            ${invited}
            ${message ? `<div class="error-box">${esc(message)}</div>` : ''}
            <div class="auth-tabs">
              <button class="${state.authMode === 'login' ? 'active' : ''}" data-action="auth-mode" data-mode="login">Sign in</button>
              <button class="${state.authMode === 'signup' ? 'active' : ''}" data-action="auth-mode" data-mode="signup">Create account</button>
            </div>
            <form id="auth-form">
              ${state.authMode === 'signup' ? `<div class="field"><label>Your name</label><input class="input" name="display_name" autocomplete="name" placeholder="Adam" required></div>` : ''}
              <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" placeholder="you@boxedup.games" required></div>
              <div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="${state.authMode === 'login' ? 'current-password' : 'new-password'}" minlength="6" placeholder="••••••••" required></div>
              <button class="btn primary block" type="submit">${state.authMode === 'login' ? 'Sign in' : 'Create account'}</button>
            </form>
          </div>
        </section>
      </div>`;
  }

  async function bootUser() {
    try {
      if (inviteToken) {
        const { error } = await state.db.rpc('accept_workspace_invite', { p_token: inviteToken });
        if (error) {
          // Let the user continue into an existing workspace but surface invite problems.
          toast(error.message, 'error');
        } else {
          toast('Workspace invite accepted.');
          const clean = `${window.location.pathname}${window.location.hash || ''}`;
          history.replaceState({}, '', clean);
        }
      }

      await loadWorkspaces();
      if (!state.workspaces.length) {
        renderWorkspaceOnboarding();
        return;
      }

      const remembered = localStorage.getItem('boxed-up-workspace');
      state.workspace = state.workspaces.find(w => w.id === remembered) || state.workspaces[0];
      localStorage.setItem('boxed-up-workspace', state.workspace.id);
      await loadWorkspaceData();
      bindRealtime();
      routeFromHash();
      renderShell();
    } catch (err) {
      console.error(err);
      renderFatal(err);
    }
  }

  async function loadWorkspaces() {
    const { data, error } = await state.db
      .from('workspace_members')
      .select('workspace_id, role, workspaces(id,name,created_by,created_at)')
      .eq('user_id', state.user.id)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    state.workspaces = (data || []).map(row => ({ ...row.workspaces, my_role: row.role })).filter(Boolean);
  }

  async function loadWorkspaceData() {
    const ws = state.workspace.id;
    const [membersRes, rolesRes, trackersRes, itemsRes, activityRes] = await Promise.all([
      state.db.from('workspace_members').select('workspace_id,user_id,role,joined_at').eq('workspace_id', ws).order('joined_at'),
      state.db.from('workspace_roles').select('*').eq('workspace_id', ws).order('sort_order').order('created_at'),
      state.db.from('trackers').select('*').eq('workspace_id', ws).eq('archived', false).order('sort_order').order('created_at'),
      state.db.from('items').select('*').eq('workspace_id', ws).order('sort_order').order('created_at'),
      state.db.from('activity_log').select('*').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(120)
    ]);
    if (membersRes.error) throw membersRes.error;
    if (rolesRes.error) throw rolesRes.error;
    if (trackersRes.error) throw trackersRes.error;
    if (itemsRes.error) throw itemsRes.error;

    state.members = membersRes.data || [];
    state.roles = rolesRes.data || [];
    state.trackers = trackersRes.data || [];
    state.items = itemsRes.data || [];
    state.activityAvailable = !activityRes.error;
    state.activity = activityRes.error ? [] : (activityRes.data || []);

    const ids = state.members.map(m => m.user_id);
    state.profiles = new Map();
    if (ids.length) {
      const { data: profiles, error } = await state.db.from('profiles').select('*').in('id', ids);
      if (error) throw error;
      (profiles || []).forEach(p => state.profiles.set(p.id, p));
    }
    await syncReminderTasks();
    startReminderLoop();
  }

  function renderWorkspaceOnboarding(message = '') {
    const isBootstrapOwner = String(state.user?.email || '').toLowerCase() === OWNER_EMAIL;
    app.innerHTML = `
      <div class="setup-shell branded-setup"><div class="setup-card">
        ${brandLogoHTML('setup-logo')}
        <div class="eyebrow">BOXED UP GAMES • TEAM HQ</div>
        <h1>${isBootstrapOwner ? 'Create Boxed Up HQ' : 'Your account is ready.'}</h1>
        <p>${isBootstrapOwner
          ? 'Your email is the protected owner account. Create the HQ once, then invite the rest of the team as Admins, Developers or Viewers.'
          : `You are not in a workspace yet. Ask <strong>${esc(OWNER_EMAIL)}</strong> for an invite link, then sign in using the invited email.`}</p>
        ${message ? `<div class="error-box">${esc(message)}</div>` : ''}
        ${isBootstrapOwner ? `<form id="workspace-form">
          <div class="field"><label>Workspace name</label><input class="input" name="name" value="Boxed Up HQ" maxlength="80" required></div>
          <button class="btn primary" type="submit">Create workspace</button>
          <button class="btn ghost" type="button" data-action="signout">Sign out</button>
        </form>` : `<button class="btn primary" type="button" data-action="refresh-memberships">Check for invite</button>
          <button class="btn ghost" type="button" data-action="signout">Sign out</button>`}
      </div></div>`;
  }

  function routeFromHash() {
    const hash = (location.hash || '#home').slice(1).split('?')[0];
    const known = new Set(['home', 'my-work', 'notifications', 'activity', 'blockers', 'current-update', 'ship-room', 'calendar', 'workload', 'team']);
    if (known.has(hash)) state.route = hash;
    else if (hash.startsWith('tracker/')) state.route = hash;
    else state.route = 'home';
  }

  function trackerFromRoute() {
    if (!state.route.startsWith('tracker/')) return null;
    const id = state.route.split('/')[1];
    return state.trackers.find(t => t.id === id) || null;
  }

  function routeLabel() {
    const tracker = trackerFromRoute();
    if (tracker) return `${tracker.icon} ${tracker.name}`;
    return ({
      home: 'HQ Overview',
      'my-work': 'My Work',
      notifications: 'Notifications',
      activity: 'Studio Feed',
      blockers: 'Blockers',
      'current-update': 'Current Update',
      'ship-room': 'Ship Room',
      calendar: 'Studio Calendar',
      workload: 'Team Workload',
      team: 'Team & Permissions'
    })[state.route] || 'Boxed Up HQ';
  }

  function navButton(route, icon, label, extra = '') {
    return `<button class="nav-item ${state.route === route ? 'active' : ''}" data-route="${route}">
      <span class="nav-icon">${icon}</span><span class="nav-text">${esc(label)}</span>${extra}
    </button>`;
  }

  function renderShell() {
    if (!state.user || !state.workspace) return;
    const me = state.profiles.get(state.user.id) || { email: state.user.email, display_name: state.user.user_metadata?.display_name };
    const role = roleLabel(myRole());
    const notification = notificationState();
    const todoTracker = state.trackers.find(t => /overarching|to-do|todo/i.test(t.name));
    const issueTracker = state.trackers.find(t => /issue/i.test(t.name));
    const weeklyTracker = currentUpdateTracker();
    const otherTrackers = state.trackers.filter(t => ![todoTracker?.id, issueTracker?.id, weeklyTracker?.id].includes(t.id));
    const unread = unreadNotificationCount();
    const myOpen = state.items.filter(i => i.assignee_id === state.user.id && !isComplete(i)).length;
    const blockers = state.items.filter(i => !isComplete(i) && isBlocked(i)).length;

    app.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar" id="sidebar">
          <div class="workspace-switcher" data-route="home">
            ${brandLogoHTML('ws-icon brand-image')}
            <span class="workspace-name">BOXED UP HQ</span>
            <span class="workspace-caret">⌄</span>
          </div>

          <div class="sidebar-scroll">
            ${navButton('home', '⌂', 'Home')}
            ${navButton('my-work', '◎', 'My Work', myOpen ? `<span class="nav-badge">${myOpen}</span>` : '')}
            ${navButton('notifications', '🔔', 'Notifications', unread ? `<span class="nav-badge yellow">${unread}</span>` : '')}
            ${navButton('activity', '📡', 'Studio Feed')}

            <div class="side-label">Work</div>
            ${todoTracker ? navButton(`tracker/${todoTracker.id}`, '✓', 'Tasks') : ''}
            ${issueTracker ? navButton(`tracker/${issueTracker.id}`, '👾', 'Issues') : ''}
            ${navButton('blockers', '🚨', 'Blockers', blockers ? `<span class="nav-badge danger">${blockers}</span>` : '')}
            ${otherTrackers.length ? `<div class="sidebar-subtrackers" id="tracker-nav">
              ${otherTrackers.map(t => `
                <button class="nav-item sub ${state.route === `tracker/${t.id}` ? 'active' : ''}" data-route="tracker/${t.id}" data-tracker-nav="${t.id}">
                  <span class="nav-icon">${esc(t.icon)}</span><span class="nav-text">${esc(t.name)}</span>${canEditTrackers() ? '<span class="nav-drag">⋮⋮</span>' : ''}
                </button>`).join('')}
            </div>` : '<div id="tracker-nav"></div>'}
            ${canCreateTrackers() ? `<button class="nav-item new-tracker sub" data-action="new-tracker"><span class="nav-icon">＋</span><span class="nav-text">New tracker</span></button>` : ''}

            <div class="side-label">Updates</div>
            ${navButton('current-update', '🚀', 'Current Update')}
            ${navButton('ship-room', '📦', 'Ship Room')}
            ${navButton('calendar', '📅', 'Calendar')}

            <div class="side-label">Studio</div>
            ${navButton('workload', '⚖️', 'Workload')}
            ${navButton('team', '👥', 'Team & Permissions')}
          </div>

          <div class="sidebar-footer">
            <div class="sidebar-tools">
              <button class="sidebar-tool install-action" data-action="install-pwa">⬇ Install HQ</button>
              ${notification !== 'granted' && notification !== 'unsupported' ? `<button class="sidebar-tool" data-action="enable-notifications">🔔 Enable reminders</button>` : ''}
            </div>
            <div class="user-row">
              ${avatarHTML(state.user.id)}
              <div class="user-details">
                <div class="user-name">${esc(me.display_name || 'Team member')} ${isOnline(state.user.id) ? '<span class="online-dot"></span>' : ''}</div>
                <div class="user-email">${esc(role)} • ${esc(me.email || state.user.email || '')}</div>
              </div>
              <button class="sidebar-logout" title="Sign out" data-action="signout">Log out</button>
            </div>
          </div>
        </aside>

        <button class="sidebar-backdrop" aria-label="Close menu" data-action="close-sidebar"></button>

        <main class="main">
          <header class="topbar">
            <button class="icon-btn mobile-toggle" data-action="toggle-sidebar">☰</button>
            ${brandLogoHTML('topbar-logo')}
            <div class="breadcrumb"><strong>${esc(state.workspace.name)}</strong><span>/</span>${esc(routeLabel())}</div>
            <div class="top-actions">
              ${notification !== 'granted' && notification !== 'unsupported' ? `<button class="top-chip" data-action="enable-notifications">🔔 Reminders</button>` : ''}
              <button class="icon-btn" title="Notifications" data-route="notifications">🔔${unread ? `<span class="top-badge">${unread}</span>` : ''}</button>
              <button class="icon-btn" title="Refresh" data-action="refresh">↻</button>
              <button class="icon-btn mobile-signout" title="Sign out" aria-label="Sign out" data-action="signout">↪</button>
            </div>
          </header>

          <div class="kraft-stage"><div id="page" class="workspace-page"></div></div>

          <nav class="mobile-dock" aria-label="Mobile navigation">
            <button data-route="home"><span>⌂</span><small>Home</small></button>
            <button data-route="my-work"><span>◎</span><small>My Work</small></button>
            ${canCreateItems() && (todoTracker || state.trackers[0]) ? `<button class="dock-add" data-action="new-item" data-tracker="${(todoTracker || state.trackers[0]).id}" data-status="Ready"><span>＋</span><small>Add</small></button>` : ''}
            <button data-route="notifications"><span>🔔</span><small>Alerts${unread ? ` ${unread}` : ''}</small></button>
            <button data-action="toggle-sidebar"><span>☰</span><small>Menu</small></button>
          </nav>
        </main>
      </div>`;

    renderPage();
    bindSidebarSortable();
  }

  function renderPage() {
    const page = document.getElementById('page');
    if (!page) return;
    if (state.route === 'my-work') return renderMyWork(page);
    if (state.route === 'notifications') return renderNotifications(page);
    if (state.route === 'activity') return renderActivity(page);
    if (state.route === 'blockers') return renderBlockers(page);
    if (state.route === 'current-update') return renderCurrentUpdate(page);
    if (state.route === 'ship-room') return renderShipRoom(page);
    if (state.route === 'calendar') return renderCalendar(page);
    if (state.route === 'workload') return renderWorkload(page);
    if (state.route === 'team') {
      renderTeam(page);
      return;
    }
    const tracker = trackerFromRoute();
    if (tracker) {
      renderTracker(page, tracker);
      return;
    }
    renderDashboard(page);
  }

  function workCard(item, compact = false) {
    const tracker = trackerFor(item.tracker_id);
    const blockers = blockedByItems(item);
    return `<article class="work-card ${compact ? 'compact' : ''} ${blockers.length ? 'blocked' : ''}" data-action="edit-item" data-id="${item.id}">
      <div class="work-card-main">
        <div class="work-card-title">${esc(item.title)}</div>
        <div class="work-card-meta">
          ${tracker ? `<span>${esc(tracker.icon)} ${esc(tracker.name)}</span>` : ''}
          ${item.due_date ? `<span class="${(daysUntil(item.due_date) ?? 99) < 0 ? 'overdue-text' : ''}">${esc(dueLabel(item))}</span>` : ''}
          ${blockers.length ? `<span class="blocked-text">🔒 ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      <div class="work-card-tags">
        ${pill(item.status, statusClass(item.status), false)}
        ${item.priority ? pill(item.priority, priorityClass(item.priority)) : ''}
      </div>
    </article>`;
  }

  function renderDashboard(page) {
    const defaultTracker = state.trackers.find(t => /overarching|to-do|todo/i.test(t.name)) || state.trackers[0];
    const myTasks = state.items.filter(i => i.assignee_id === state.user.id && !isComplete(i));
    const overdue = myTasks.filter(i => (daysUntil(i.due_date) ?? 1) < 0);
    const waiting = myTasks.filter(isBlocked);
    const updateItems = currentUpdateItems();
    const readiness = updateReadiness(updateItems);
    const updateTracker = currentUpdateTracker();
    const online = state.members.filter(m => isOnline(m.user_id));
    const recent = state.activity.slice(0, 5);

    page.innerHTML = `
      <div class="content operational-dashboard">
        <section class="ops-hero">
          <div>
            <span class="eyebrow dark">• BOXED UP GAMES PRODUCTION</span>
            <h1>Boxed Up HQ</h1>
            <p>Everything that needs attention, review or shipping — in one place.</p>
          </div>
          <div class="ops-actions">
            ${canCreateItems() && defaultTracker ? `<button class="btn brand-primary" data-action="new-item" data-tracker="${defaultTracker.id}" data-status="Ready">＋ Add task</button>` : ''}
            <button class="btn brand-secondary" data-route="ship-room">Open Ship Room</button>
          </div>
        </section>

        <div class="ops-metrics">
          <button data-route="my-work"><strong>${myTasks.length}</strong><span>My open tasks</span></button>
          <button data-route="my-work"><strong>${overdue.length}</strong><span>Overdue</span></button>
          <button data-route="blockers"><strong>${waiting.length}</strong><span>My blockers</span></button>
          <button data-route="current-update"><strong>${readiness}%</strong><span>Update ready</span></button>
        </div>

        <div class="ops-grid">
          <section class="panel-card">
            <div class="panel-head"><div><span class="panel-kicker">MY WORK</span><h2>What needs you</h2></div><button class="text-btn" data-route="my-work">View all →</button></div>
            <div class="work-list">
              ${myTasks.slice().sort((a,b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))).slice(0,5).map(item => workCard(item, true)).join('') || '<div class="empty-state small">You have no active assigned tasks.</div>'}
            </div>
          </section>

          <section class="panel-card update-snapshot">
            <div class="panel-head"><div><span class="panel-kicker">CURRENT UPDATE</span><h2>${esc(updateTitle())}</h2></div><button class="text-btn" data-route="current-update">Command centre →</button></div>
            ${updateTracker ? `
              <div class="readiness-ring" style="--value:${readiness}"><div><strong>${readiness}%</strong><span>ready</span></div></div>
              <div class="snapshot-meta">
                <span>📅 ${currentReleaseDate() ? formatDate(currentReleaseDate()) : 'Release date not set'}</span>
                <span>🔒 ${updateItems.filter(isBlocked).length} blocker${updateItems.filter(isBlocked).length === 1 ? '' : 's'}</span>
                <span>👀 ${updateItems.filter(i => i.status === 'Review').length} in review</span>
              </div>` : '<div class="empty-state small">Mark a tracker as the current update in Tracker settings.</div>'}
          </section>

          <section class="panel-card">
            <div class="panel-head"><div><span class="panel-kicker">STUDIO FEED</span><h2>Recent activity</h2></div><button class="text-btn" data-route="activity">Open feed →</button></div>
            <div class="activity-mini">
              ${recent.map(entry => `<div class="activity-mini-row"><span>${activityIcon(entry)}</span><div><strong>${esc(activityActor(entry))}</strong> ${esc(activityDescription(entry, false))}<small>${formatDate(entry.created_at, true)}</small></div></div>`).join('') || '<div class="empty-state small">Activity will appear here as the team works.</div>'}
            </div>
          </section>

          <section class="panel-card">
            <div class="panel-head"><div><span class="panel-kicker">PRESENCE</span><h2>Team online</h2></div><button class="text-btn" data-route="team">Team →</button></div>
            <div class="presence-list">
              ${online.length ? online.map(m => `<div class="presence-person">${avatarHTML(m.user_id, 'lg')}<div><strong>${esc(displayName(m.user_id))}</strong><span><i class="online-dot"></i> Online • ${esc(roleLabel(m.role))}</span></div></div>`).join('') : '<div class="empty-state small">Nobody else is online right now.</div>'}
            </div>
          </section>
        </div>
      </div>`;
  }

  function renderMyWork(page) {
    const defaultTracker = state.trackers.find(t => /overarching|to-do|todo/i.test(t.name)) || state.trackers[0];
    const mine = state.items.filter(item => item.assignee_id === state.user.id && !isComplete(item));
    const overdue = mine.filter(item => (daysUntil(item.due_date) ?? 1) < 0);
    const dueSoon = mine.filter(item => {
      const days = daysUntil(item.due_date);
      return days !== null && days >= 0 && days <= 3;
    });
    const active = mine.filter(item => item.status === 'In progress');
    const review = mine.filter(item => ['Review', 'Testing'].includes(item.status));
    const queued = mine.filter(item => ['Backlog', 'Ready'].includes(item.status));

    const section = (title, icon, items, empty) => `
      <section class="my-work-section">
        <div class="section-heading compact"><div><h2>${icon} ${esc(title)}</h2><p>${items.length} task${items.length === 1 ? '' : 's'}</p></div></div>
        <div class="work-list">${items.map(item => workCard(item)).join('') || `<div class="empty-state small">${esc(empty)}</div>`}</div>
      </section>`;

    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">PERSONAL QUEUE</span><h1>My Work</h1><p>Only the work assigned to you, ordered around deadlines and what is blocking progress.</p></div>
          ${canCreateItems() && defaultTracker ? `<button class="btn brand-primary" data-action="new-item" data-tracker="${defaultTracker.id}" data-status="Ready">＋ New task</button>` : ''}
        </div>
        <div class="quick-stat-row">
          <div><strong>${mine.length}</strong><span>Open</span></div>
          <div class="${overdue.length ? 'danger-stat' : ''}"><strong>${overdue.length}</strong><span>Overdue</span></div>
          <div><strong>${mine.filter(isBlocked).length}</strong><span>Blocked</span></div>
          <div><strong>${review.length}</strong><span>Review / test</span></div>
        </div>
        <div class="my-work-grid">
          ${section('Overdue', '🚨', overdue, 'Nothing overdue.')}
          ${section('Due in the next 3 days', '⏰', dueSoon.filter(i => !overdue.includes(i)), 'No immediate deadlines.')}
          ${section('In progress', '⚡', active, 'Nothing currently in progress.')}
          ${section('Review & testing', '👀', review, 'Nothing waiting in review or testing.')}
          ${section('Ready / backlog', '📥', queued, 'Your queue is clear.')}
        </div>
      </div>`;
  }

  function activityIcon(entry) {
    if (entry.action === 'created') return '＋';
    if (entry.action === 'deleted') return '🗑️';
    if (entry.action === 'status_changed') return '➜';
    if (entry.action === 'assigned') return '👤';
    if (entry.action === 'due_date_changed') return '📅';
    if (entry.action === 'dependencies_changed') return '🔗';
    if (entry.entity_type === 'member') return '👥';
    return '✎';
  }

  function activityDescription(entry, includeActor = true) {
    const title = entry.entity_title || 'an item';
    const actor = includeActor ? `${activityActor(entry)} ` : '';
    const meta = entry.metadata || {};
    if (entry.action === 'created') return `${actor}created ${title}`;
    if (entry.action === 'deleted') return `${actor}deleted ${title}`;
    if (entry.action === 'status_changed') return `${actor}moved ${title} from ${meta.from_status || '—'} → ${meta.to_status || '—'}`;
    if (entry.action === 'assigned') return `${actor}changed the assignee on ${title}`;
    if (entry.action === 'due_date_changed') return `${actor}changed the due date on ${title}`;
    if (entry.action === 'dependencies_changed') return `${actor}updated dependencies for ${title}`;
    if (entry.action === 'member_joined') return `${actor}added a team member`;
    if (entry.action === 'member_removed') return `${actor}removed a team member`;
    if (entry.action === 'role_changed') return `${actor}changed a team role from ${meta.from_role || '—'} → ${meta.to_role || '—'}`;
    return `${actor}updated ${title}`;
  }

  function renderActivity(page) {
    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">LIVE COLLABORATION</span><h1>Studio Feed</h1><p>A lightweight activity trail so the team can see what changed without chasing updates in chat.</p></div>
          <button class="btn brand-secondary" data-action="refresh">↻ Refresh</button>
        </div>
        ${!state.activityAvailable ? '<div class="info-box">Run the updated <code>supabase/schema.sql</code> to enable the shared activity feed.</div>' : ''}
        <div class="activity-feed">
          ${state.activity.map(entry => `<article class="activity-row">
            <div class="activity-avatar">${entry.actor_id ? avatarHTML(entry.actor_id) : '<span class="avatar sm">HQ</span>'}</div>
            <div class="activity-copy">
              <div><strong>${esc(activityActor(entry))}</strong> ${esc(activityDescription(entry, false))}</div>
              <span>${formatDate(entry.created_at, true)}</span>
            </div>
            <div class="activity-type">${activityIcon(entry)}</div>
          </article>`).join('') || '<div class="empty-state">No activity yet. Changes to tasks, trackers and team roles will appear here.</div>'}
        </div>
      </div>`;
  }

  function renderNotifications(page) {
    const notices = buildNotifications();
    const read = readNotificationIds();
    const unread = notices.filter(n => !read.has(n.id)).length;
    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">ATTENTION CENTRE</span><h1>Notifications</h1><p>Deadlines, blockers, review requests and task changes that actually need your attention.</p></div>
          <div class="feature-actions">
            ${notificationState() !== 'granted' && notificationState() !== 'unsupported' ? `<button class="btn brand-secondary" data-action="enable-notifications">Enable device alerts</button>` : ''}
            ${unread ? `<button class="btn brand-primary" data-action="mark-all-notifications">Mark all read</button>` : ''}
          </div>
        </div>
        <div class="notification-summary"><strong>${unread}</strong> unread • ${notices.length} current</div>
        <div class="notification-list">
          ${notices.map(n => `<button class="notification-row ${read.has(n.id) ? 'read' : 'unread'} ${n.kind}" data-action="open-notification" data-notification="${esc(n.id)}" data-id="${esc(n.item_id || '')}">
            <span class="notification-icon">${n.icon}</span>
            <span class="notification-copy"><strong>${esc(n.title)}</strong><small>${esc(n.body)}</small></span>
            ${!read.has(n.id) ? '<i class="unread-dot"></i>' : ''}
          </button>`).join('') || '<div class="empty-state">You are caught up.</div>'}
        </div>
      </div>`;
  }

  function renderBlockers(page) {
    const blocked = state.items.filter(item => !isComplete(item) && isBlocked(item));
    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">UNBLOCK THE TEAM</span><h1>Blockers</h1><p>Work that cannot finish until another task is completed.</p></div>
          <span class="big-count danger">${blocked.length}</span>
        </div>
        <div class="blocker-list">
          ${blocked.map(item => {
            const deps = blockedByItems(item);
            return `<article class="blocker-card">
              <div class="blocker-main" data-action="edit-item" data-id="${item.id}">
                <div class="blocker-title"><span>🔒</span><div><strong>${esc(item.title)}</strong><small>${esc(trackerFor(item.tracker_id)?.name || '')}</small></div></div>
                <div class="work-card-tags">${pill(item.status, statusClass(item.status), false)}${item.priority ? pill(item.priority, priorityClass(item.priority)) : ''}</div>
              </div>
              <div class="dependency-chain">
                <span>Waiting on</span>
                ${deps.map(dep => `<button data-action="edit-item" data-id="${dep.id}">${esc(dep.title)} ${pill(dep.status, statusClass(dep.status), false)}</button>`).join('')}
              </div>
            </article>`;
          }).join('') || '<div class="empty-state">No blocked tasks. Nice.</div>'}
        </div>
      </div>`;
  }

  function departmentProgress(items) {
    const groups = new Map();
    items.forEach(item => {
      const category = categoryForItem(item);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    });
    return [...groups.entries()].map(([name, tasks]) => ({
      name,
      count: tasks.length,
      progress: updateReadiness(tasks)
    })).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function renderCurrentUpdate(page) {
    const tracker = currentUpdateTracker();
    if (!tracker) {
      page.innerHTML = `<div class="content feature-page"><div class="empty-state">No current update is configured. Edit a tracker and mark it as the current update.</div></div>`;
      return;
    }
    const items = currentUpdateItems();
    const readiness = updateReadiness(items);
    const blockers = items.filter(isBlocked);
    const overdue = items.filter(item => !isComplete(item) && (daysUntil(item.due_date) ?? 1) < 0);
    const review = items.filter(item => item.status === 'Review');
    const departments = departmentProgress(items);
    const release = currentReleaseDate();
    const releaseDays = release ? daysUntil(release) : null;

    page.innerHTML = `
      <div class="content feature-page update-centre">
        <div class="feature-head">
          <div>
            <span class="eyebrow">WEEKLY UPDATE COMMAND CENTRE</span>
            <h1>${esc(updateTitle())}</h1>
            <p>${release ? `Release ${formatDate(release)}${releaseDays !== null ? ` • ${releaseDays < 0 ? `${Math.abs(releaseDays)}d late` : releaseDays === 0 ? 'ships today' : `${releaseDays}d to ship`}` : ''}` : 'Set a release date in tracker settings.'}</p>
          </div>
          <div class="feature-actions">
            <button class="btn brand-secondary" data-route="tracker/${tracker.id}">Open task board</button>
            <button class="btn brand-primary" data-route="ship-room">📦 Ship Room</button>
          </div>
        </div>

        <div class="update-readiness-card">
          <div class="readiness-number"><strong>${readiness}%</strong><span>RELEASE READINESS</span></div>
          <div class="readiness-bar"><span style="width:${readiness}%"></span></div>
          <div class="update-health">
            <div class="${blockers.length ? 'bad' : 'good'}"><strong>${blockers.length}</strong><span>Blockers</span></div>
            <div class="${overdue.length ? 'bad' : 'good'}"><strong>${overdue.length}</strong><span>Overdue</span></div>
            <div><strong>${review.length}</strong><span>Awaiting review</span></div>
            <div><strong>${items.filter(isComplete).length}/${items.length}</strong><span>Approved / shipped</span></div>
          </div>
        </div>

        ${blockers.length ? `<div class="release-warning"><strong>⚠ ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} may prevent release.</strong><button class="text-btn" data-route="blockers">Open blockers →</button></div>` : ''}

        <div class="update-grid">
          <section class="panel-card">
            <div class="panel-head"><div><span class="panel-kicker">DEPARTMENTS</span><h2>Progress by area</h2></div></div>
            <div class="department-list">
              ${departments.map(dep => `<div class="department-row"><div><strong>${esc(dep.name)}</strong><span>${dep.count} task${dep.count === 1 ? '' : 's'}</span></div><div class="department-bar"><span style="width:${dep.progress}%"></span></div><b>${dep.progress}%</b></div>`).join('') || '<div class="empty-state small">No update tasks yet.</div>'}
            </div>
          </section>
          <section class="panel-card">
            <div class="panel-head"><div><span class="panel-kicker">RELEASE QUEUE</span><h2>Tasks</h2></div></div>
            <div class="work-list">${items.slice().sort((a,b) => workflowProgress(a)-workflowProgress(b)).map(item => workCard(item, true)).join('') || '<div class="empty-state small">No tasks yet.</div>'}</div>
          </section>
        </div>
      </div>`;
  }

  function calendarEntries() {
    const entries = state.items
      .filter(item => item.due_date && !isComplete(item))
      .map(item => ({
        id: `task-${item.id}`,
        date: item.due_date,
        title: item.title,
        description: `${trackerFor(item.tracker_id)?.name || 'Boxed Up HQ'}${item.description ? ` — ${item.description}` : ''}`,
        item_id: item.id,
        kind: 'Task'
      }));
    const release = currentReleaseDate();
    if (release) entries.push({
      id: `release-${currentUpdateTracker()?.id || 'current'}`,
      date: release,
      title: `🚀 ${updateTitle()} release`,
      description: 'Boxed Up Games weekly update release',
      item_id: null,
      kind: 'Release'
    });
    return entries.sort((a,b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }

  function nextDateYmd(dateValue) {
    const d = new Date(`${dateValue}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0,10).replaceAll('-', '');
  }

  function escapeIcs(value = '') {
    return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
  }

  function makeIcs(entries) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const body = entries.map(event => [
      'BEGIN:VEVENT',
      `UID:${escapeIcs(event.id)}@boxeduphq`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${event.date.replaceAll('-', '')}`,
      `DTEND;VALUE=DATE:${nextDateYmd(event.date)}`,
      `SUMMARY:${escapeIcs(event.title)}`,
      `DESCRIPTION:${escapeIcs(event.description || '')}`,
      'END:VEVENT'
    ].join('\r\n')).join('\r\n');
    return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Boxed Up Games//Boxed Up HQ//EN\r\nCALSCALE:GREGORIAN\r\n${body}\r\nEND:VCALENDAR\r\n`;
  }

  function downloadCalendar(entries, filename = 'boxed-up-hq-calendar.ics') {
    const blob = new Blob([makeIcs(entries)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function googleCalendarUrl(event) {
    const start = event.date.replaceAll('-', '');
    const end = nextDateYmd(event.date);
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.title,
      dates: `${start}/${end}`,
      details: event.description || 'Boxed Up HQ',
      sf: 'true',
      output: 'xml'
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function renderCalendar(page) {
    const entries = calendarEntries();
    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">STUDIO SCHEDULE</span><h1>Calendar</h1><p>Deadlines and releases from HQ, with one-tap export to your device calendar or Google Calendar.</p></div>
          <div class="feature-actions">
            ${entries.length ? `<button class="btn brand-primary" data-action="export-calendar">Export all (.ics)</button>` : ''}
          </div>
        </div>
        <div class="calendar-list">
          ${entries.map(event => {
            const days = daysUntil(event.date);
            return `<article class="calendar-row">
              <div class="calendar-date"><strong>${new Date(`${event.date}T12:00:00`).toLocaleDateString('en-GB',{day:'2-digit'})}</strong><span>${new Date(`${event.date}T12:00:00`).toLocaleDateString('en-GB',{month:'short'}).toUpperCase()}</span></div>
              <div class="calendar-main">
                <span class="panel-kicker">${esc(event.kind)}</span>
                <strong>${esc(event.title)}</strong>
                <small>${days === null ? '' : days < 0 ? `${Math.abs(days)} day${Math.abs(days)===1?'':'s'} overdue` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`}</small>
              </div>
              <div class="calendar-actions">
                ${event.item_id ? `<button class="btn small" data-action="edit-item" data-id="${event.item_id}">Open</button>` : ''}
                <button class="btn small" data-action="export-calendar-event" data-calendar-id="${esc(event.id)}">Add to device</button>
                <button class="btn small" data-action="google-calendar" data-calendar-id="${esc(event.id)}">Google</button>
              </div>
            </article>`;
          }).join('') || '<div class="empty-state">No upcoming dated work.</div>'}
        </div>
        <div class="info-box calendar-note"><strong>Apple Calendar / Outlook / local apps:</strong> use the .ics buttons. On iPhone, Safari/iOS will offer the calendar file to your device. Google Calendar opens a pre-filled event in Google Calendar.</div>
      </div>`;
  }

  function renderWorkload(page) {
    const rows = state.members.map(member => {
      const active = state.items.filter(item => item.assignee_id === member.user_id && !isComplete(item));
      const weight = active.reduce((sum, item) => sum + (EFFORT_WEIGHT[item.effort_level] || 1), 0);
      const overdue = active.filter(item => (daysUntil(item.due_date) ?? 1) < 0).length;
      const blocked = active.filter(isBlocked).length;
      return { member, active, weight, overdue, blocked };
    }).sort((a,b) => b.weight - a.weight);
    const maxWeight = Math.max(1, ...rows.map(row => row.weight));

    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">CAPACITY VIEW</span><h1>Team Workload</h1><p>Effort-weighted visibility into who has work, who is overloaded and who is being blocked.</p></div>
        </div>
        <div class="workload-list">
          ${rows.map(row => `<article class="workload-row">
            <div class="workload-person">
              ${avatarHTML(row.member.user_id, 'lg')}
              <div><strong>${esc(displayName(row.member.user_id))} ${isOnline(row.member.user_id) ? '<i class="online-dot"></i>' : ''}</strong><span>${esc(roleLabel(row.member.role))}</span></div>
            </div>
            <div class="workload-bar-wrap">
              <div class="workload-meta"><span>${row.active.length} active task${row.active.length === 1 ? '' : 's'}</span><span>${row.weight} effort point${row.weight === 1 ? '' : 's'}</span></div>
              <div class="workload-bar"><span style="width:${Math.round(row.weight/maxWeight*100)}%"></span></div>
            </div>
            <div class="workload-flags">
              ${row.overdue ? `<span class="pill red no-dot">${row.overdue} overdue</span>` : ''}
              ${row.blocked ? `<span class="pill yellow no-dot">${row.blocked} blocked</span>` : ''}
              ${!row.overdue && !row.blocked ? '<span class="pill green no-dot">Clear</span>' : ''}
            </div>
          </article>`).join('')}
        </div>
        <div class="help workload-help">Effort weighting: Small = 1, Medium = 2, Large = 4. Unset effort counts as 1.</div>
      </div>`;
  }

  function shipStageLabel(stage) {
    return ({
      planning: 'Planning',
      playtest: 'Final Playtest',
      'release-candidate': 'Release Candidate',
      approved: 'Approved to Ship',
      shipped: 'Shipped'
    })[stage] || 'Planning';
  }

  function renderShipRoom(page) {
    const tracker = currentUpdateTracker();
    if (!tracker) {
      page.innerHTML = `<div class="content feature-page"><div class="empty-state">No current update configured.</div></div>`;
      return;
    }
    const items = currentUpdateItems();
    const blockers = items.filter(isBlocked);
    const notReady = items.filter(item => !COMPLETE_STATUSES.has(item.status));
    const overdue = items.filter(item => !isComplete(item) && (daysUntil(item.due_date) ?? 1) < 0);
    const stage = tracker.settings?.shipStage || (tracker.settings?.shippedAt ? 'shipped' : 'planning');
    const canRC = blockers.length === 0;
    const canApproveRelease = blockers.length === 0 && items.every(item => ['Testing','Approved','Shipped'].includes(item.status));
    const canShip = items.length > 0 && blockers.length === 0 && items.every(item => ['Approved','Shipped'].includes(item.status));

    page.innerHTML = `
      <div class="content feature-page ship-room">
        <div class="ship-room-head">
          <div>
            <span class="eyebrow dark">• RELEASE CONTROL</span>
            <h1>Ship Room</h1>
            <p>${esc(updateTitle())} • ${currentReleaseDate() ? formatDate(currentReleaseDate()) : 'No release date'}</p>
          </div>
          <div class="ship-stage-stamp">${esc(shipStageLabel(stage))}</div>
        </div>

        <div class="ship-readiness">
          <div><span>RELEASE READINESS</span><strong>${updateReadiness(items)}%</strong></div>
          <div class="readiness-bar dark"><span style="width:${updateReadiness(items)}%"></span></div>
        </div>

        <div class="ship-status-grid">
          <div class="${blockers.length ? 'bad' : 'good'}"><span>BLOCKERS</span><strong>${blockers.length}</strong></div>
          <div class="${overdue.length ? 'bad' : 'good'}"><span>OVERDUE</span><strong>${overdue.length}</strong></div>
          <div><span>NOT APPROVED</span><strong>${notReady.length}</strong></div>
          <div><span>APPROVED</span><strong>${items.filter(i => i.status === 'Approved').length}</strong></div>
        </div>

        <section class="ship-checklist panel-card">
          <div class="panel-head"><div><span class="panel-kicker">RELEASE GATES</span><h2>Before you ship</h2></div></div>
          <div class="release-gates">
            <div class="${blockers.length ? 'fail' : 'pass'}"><span>${blockers.length ? '×' : '✓'}</span><div><strong>No blocking dependencies</strong><small>${blockers.length ? `${blockers.length} unresolved` : 'Clear'}</small></div></div>
            <div class="${overdue.length ? 'fail' : 'pass'}"><span>${overdue.length ? '×' : '✓'}</span><div><strong>No overdue release work</strong><small>${overdue.length ? `${overdue.length} overdue` : 'Clear'}</small></div></div>
            <div class="${canShip ? 'pass' : 'wait'}"><span>${canShip ? '✓' : '…'}</span><div><strong>All tasks approved</strong><small>${items.filter(i => ['Approved','Shipped'].includes(i.status)).length}/${items.length} ready</small></div></div>
          </div>
        </section>

        ${canShipUpdates() ? `<div class="ship-actions">
          <button class="ship-action ${stage === 'playtest' ? 'active' : ''}" data-action="ship-stage" data-stage="playtest"><span>🧪</span><strong>Start Final Playtest</strong><small>Signal that the update is in its final QA pass.</small></button>
          <button class="ship-action ${stage === 'release-candidate' ? 'active' : ''}" data-action="ship-stage" data-stage="release-candidate" ${canRC ? '' : 'disabled'}><span>📦</span><strong>Mark Release Candidate</strong><small>Requires all dependency blockers to be clear.</small></button>
          <button class="ship-action ${stage === 'approved' ? 'active' : ''}" data-action="ship-stage" data-stage="approved" ${canApproveRelease ? '' : 'disabled'}><span>✅</span><strong>Approve Update</strong><small>Requires tasks to be testing, approved or shipped.</small></button>
          <button class="ship-action ship-now ${stage === 'shipped' ? 'active' : ''}" data-action="ship-update" ${canShip || stage === 'shipped' ? '' : 'disabled'}><span>🚀</span><strong>${stage === 'shipped' ? 'Update Shipped' : 'Ship Update'}</strong><small>${stage === 'shipped' ? `Shipped ${tracker.settings?.shippedAt ? formatDate(tracker.settings.shippedAt, true) : ''}` : 'Marks every Approved task as Shipped.'}</small></button>
        </div>` : '<div class="info-box">Your role can view release readiness, but only a role with <strong>Ship updates</strong> permission can operate the Ship Room controls.</div>'}

        ${blockers.length ? `<section class="panel-card"><div class="panel-head"><div><span class="panel-kicker">BLOCKERS</span><h2>Resolve before shipping</h2></div><button class="text-btn" data-route="blockers">Open all →</button></div><div class="work-list">${blockers.map(item => workCard(item,true)).join('')}</div></section>` : ''}
      </div>`;
  }

  function renderTracker(page, tracker) {
    const requestedView = state.viewOverrides[tracker.id] || tracker.kind;
    page.innerHTML = `
      <div class="content wide">
        <div class="page-head">
          <div class="page-icon">${esc(tracker.icon)}</div>
          <div class="page-head-copy">
            <h1 class="page-title">${esc(tracker.name)}</h1>
            <p class="page-subtitle">${esc(tracker.description || '')}</p>
          </div>
          <div class="page-head-actions">
            ${canEditTrackers() ? `<button class="btn ghost" data-action="edit-tracker" data-id="${tracker.id}">•••</button>` : ''}
          </div>
        </div>
        <div class="toolbar">
          <button class="view-tab ${requestedView === 'kanban' ? 'active' : ''}" data-action="switch-view" data-id="${tracker.id}" data-view="kanban">➜ By Status</button>
          <button class="view-tab ${requestedView === 'table' ? 'active' : ''}" data-action="switch-view" data-id="${tracker.id}" data-view="table">★ All ${tracker.kind === 'kanban' ? 'Projects' : 'Tasks'}</button>
          ${requestedView === 'table' ? `<button class="view-tab ${state.tableFilter[tracker.id] === 'mine' ? 'active' : ''}" data-action="toggle-my-tasks" data-id="${tracker.id}">👤 My Tasks</button>` : ''}
          <span class="spacer"></span>
          <button class="toolbar-icon" title="Refresh" data-action="refresh">↻</button>
          ${canCreateItems() ? `<button class="new-btn" data-action="new-item" data-tracker="${tracker.id}" data-status="Ready">New⌄</button>` : ''}
        </div>
        <div id="tracker-body"></div>
      </div>`;

    const body = document.getElementById('tracker-body');
    if (requestedView === 'kanban') renderKanban(body, tracker);
    else renderTable(body, tracker);
  }

  function itemsForTracker(trackerId) {
    let items = state.items.filter(i => i.tracker_id === trackerId);
    if (state.tableFilter[trackerId] === 'mine') items = items.filter(i => i.assignee_id === state.user.id);
    return items;
  }

  function renderTable(root, tracker) {
    const preset = tracker.settings?.tablePreset || 'tasks';
    const items = itemsForTracker(tracker.id);
    const issueColumns = `
      <colgroup><col style="width:280px"><col style="width:175px"><col style="width:145px"><col style="width:110px"><col style="width:135px"><col style="width:120px"><col style="width:145px"><col style="width:160px"></colgroup>
      <thead><tr><th>Aa &nbsp; Issue</th><th>👥 &nbsp; Assigned to</th><th>◷ &nbsp; Created time</th><th>◷ &nbsp; Days open</th><th>▣ &nbsp; Due date</th><th>◉ &nbsp; Priority</th><th>◌ &nbsp; Status</th><th>☷ &nbsp; Type</th></tr></thead>`;
    const taskColumns = `
      <colgroup><col style="width:275px"><col style="width:145px"><col style="width:160px"><col style="width:130px"><col style="width:110px"><col style="width:160px"><col style="width:275px"><col style="width:145px"><col style="width:125px"></colgroup>
      <thead><tr><th>Aa &nbsp; Task name</th><th>◌ &nbsp; Status</th><th>👥 &nbsp; Assignee</th><th>▣ &nbsp; Due date</th><th>◉ &nbsp; Priority</th><th>◒ &nbsp; Task type</th><th>☰ &nbsp; Description</th><th>◷ &nbsp; Updated at</th><th>⌛ &nbsp; Effort level</th></tr></thead>`;

    root.innerHTML = `
      <div class="table-wrap"><table class="data-table">
        ${preset === 'issues' ? issueColumns : taskColumns}
        <tbody>
          ${items.map(item => preset === 'issues' ? issueRow(item) : taskRow(item)).join('')}
          ${canCreateItems() ? `<tr class="new-row" data-action="new-item" data-tracker="${tracker.id}" data-status="Ready"><td colspan="9">＋ &nbsp; New ${preset === 'issues' ? 'issue' : 'task'}</td></tr>` : ''}
        </tbody>
      </table></div>`;
  }

  function issueRow(item) {
    return `<tr>
      <td data-label="Issue" class="title-cell" data-action="edit-item" data-id="${item.id}">${esc(item.title)}</td>
      <td data-label="Assigned to">${assigneeCell(item)}</td>
      <td data-label="Created">${formatDate(item.created_at)}</td>
      <td data-label="Days open">${daysOpen(item.created_at, item.status)}</td>
      <td data-label="Due date">${formatDate(item.due_date)}</td>
      <td data-label="Priority">${item.priority ? pill(item.priority, priorityClass(item.priority)) : '<span class="empty-cell">—</span>'}</td>
      <td data-label="Status">${statusEditor(item)}</td>
      <td data-label="Type">${item.item_type ? pill(item.item_type, typeClass(item.item_type)) : '<span class="empty-cell">—</span>'}</td>
    </tr>`;
  }

  function taskRow(item) {
    return `<tr>
      <td data-label="Task" class="title-cell" data-action="edit-item" data-id="${item.id}">${esc(item.title)}</td>
      <td data-label="Status">${statusEditor(item)}</td>
      <td data-label="Assignee">${assigneeCell(item)}</td>
      <td data-label="Due date">${formatDate(item.due_date)}</td>
      <td data-label="Priority">${item.priority ? pill(item.priority, priorityClass(item.priority)) : '<span class="empty-cell">—</span>'}</td>
      <td data-label="Type">${item.item_type ? pill(item.item_type, typeClass(item.item_type)) : '<span class="empty-cell">—</span>'}</td>
      <td data-label="Description">${item.description ? esc(item.description) : '<span class="empty-cell">—</span>'}</td>
      <td data-label="Updated">${formatDate(item.updated_at)}</td>
      <td data-label="Effort">${item.effort_level ? pill(item.effort_level, effortClass(item.effort_level)) : '<span class="empty-cell">—</span>'}</td>
    </tr>`;
  }

  function assigneeCell(item) {
    if (!item.assignee_id) return '<span class="empty-cell">—</span>';
    return `<span style="display:inline-flex;align-items:center;gap:7px">${avatarHTML(item.assignee_id)}<span>${esc(displayName(item.assignee_id))}</span></span>`;
  }

  function statusEditor(item) {
    if (!canEditItems()) return pill(item.status, statusClass(item.status), false);
    return `<span class="pill ${statusClass(item.status)} no-dot"><select class="inline-select" data-inline-status="${item.id}">${allowedStatuses(item.status).map(s => `<option ${s === item.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></span>`;
  }

  function renderKanban(root, tracker) {
    const items = state.items.filter(i => i.tracker_id === tracker.id);
    root.innerHTML = `
      <div class="kanban-wrap"><div class="kanban">
        ${STATUS.map(status => {
          const columnItems = items.filter(i => i.status === status).sort((a,b) => a.sort_order - b.sort_order);
          return `<section class="kanban-column" data-status="${status}">
            <div class="kanban-head">${pill(status, statusClass(status), false)} <span class="kanban-count">${columnItems.length}</span></div>
            <div class="kanban-list" data-kanban-list data-status="${status}">
              ${columnItems.map(kanbanCard).join('')}
            </div>
            ${canCreateItems() ? `<button class="card-new" data-action="new-item" data-tracker="${tracker.id}" data-status="${status}">＋ &nbsp; New project</button>` : ''}
          </section>`;
        }).join('')}
      </div></div>`;

    if (canEditItems()) bindKanbanSortable(tracker.id);
  }

  function kanbanCard(item) {
    return `<article class="kanban-card" data-item-id="${item.id}" data-action="edit-item" data-id="${item.id}">
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-meta">
        ${item.assignee_id ? `${avatarHTML(item.assignee_id)} <span>${esc(displayName(item.assignee_id))}</span>` : '<span>Unassigned</span>'}
        ${item.priority ? pill(item.priority, priorityClass(item.priority)) : ''}
      </div>
      <div class="progress"><span style="width:${Math.max(0, Math.min(100, item.progress || 0))}%"></span></div>
      <div class="help" style="margin-top:5px">${item.progress || 0}%</div>
    </article>`;
  }

  function bindKanbanSortable(trackerId) {
    $$('[data-kanban-list]').forEach(list => {
      new Sortable(list, {
        group: `tracker-${trackerId}`,
        animation: 150,
        ghostClass: 'sortable-ghost',
        onMove: evt => {
          const targetStatus = evt.to?.dataset?.status;
          if (targetStatus === 'Approved' && !canApproveItems()) return false;
          if (targetStatus === 'Shipped' && !canShipUpdates()) return false;
          return true;
        },
        onEnd: async () => {
          try {
            const updates = [];
            $$('[data-kanban-list]').forEach(column => {
              const status = column.dataset.status;
              [...column.querySelectorAll('[data-item-id]')].forEach((card, index) => {
                const item = state.items.find(i => i.id === card.dataset.itemId);
                if (!item) return;
                item.status = status;
                item.sort_order = (index + 1) * 10;
                if (COMPLETE_STATUSES.has(status) && item.progress < 100) item.progress = 100;
                updates.push(state.db.from('items').update({
                  status,
                  sort_order: item.sort_order,
                  progress: item.progress
                }).eq('id', item.id));
              });
            });
            const results = await Promise.all(updates);
            const failed = results.find(r => r.error);
            if (failed) throw failed.error;
          } catch (err) {
            toast(err.message, 'error');
            await refreshAll();
          }
        }
      });
    });
  }

  function bindSidebarSortable() {
    const el = document.getElementById('tracker-nav');
    if (!el || !canEditTrackers()) return;
    new Sortable(el, {
      animation: 120,
      handle: '.nav-drag',
      onEnd: async () => {
        const ids = [...el.querySelectorAll('[data-tracker-nav]')].map(n => n.dataset.trackerNav);
        const results = await Promise.all(ids.map((id, index) => state.db.from('trackers').update({ sort_order: 100 + (index + 1) * 10 }).eq('id', id)));
        const failed = results.find(r => r.error);
        if (failed) toast(failed.error.message, 'error');
      }
    });
  }

  function roleOptions(selected = '', includeOwner = false) {
    return state.roles
      .filter(role => includeOwner || role.role_key !== 'owner')
      .map(role => `<option value="${esc(role.role_key)}" ${role.role_key === selected ? 'selected' : ''}>${iconForRole(role.role_key)} ${esc(role.name)}</option>`)
      .join('');
  }

  function rolePermissionEditor(role) {
    const locked = role.role_key === 'owner';
    return `<div class="role-card" data-role-card="${esc(role.role_key)}">
      <div class="role-card-head">
        <div><div class="role-title">${pill(`${iconForRole(role.role_key)} ${role.name}`, roleClass(role.role_key))}</div><p>${esc(role.description || '')}</p></div>
        <div class="role-card-actions">
          ${role.role_key !== 'owner' ? `<button class="btn ghost small" data-action="edit-role" data-role="${esc(role.role_key)}">Edit details</button>` : '<span class="locked-role">Protected</span>'}
        </div>
      </div>
      <div class="permission-grid">
        ${ROLE_PERMISSIONS.map(([key, label, description]) => {
          const checked = role.role_key === 'owner' || role.permissions?.[key] === true;
          return `<label class="permission-row ${locked ? 'locked' : ''}">
            <span><strong>${esc(label)}</strong><small>${esc(description)}</small></span>
            <input type="checkbox" data-role-perm="${esc(role.role_key)}" data-permission="${esc(key)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          </label>`;
        }).join('')}
      </div>
      ${!locked ? `<div class="role-save-row"><button class="btn brand-primary small" data-action="save-role-permissions" data-role="${esc(role.role_key)}">Save ${esc(role.name)} permissions</button></div>` : ''}
    </div>`;
  }

  async function renderTeam(page) {
    let invitesHTML = '';
    if (canInviteMembers()) {
      const { data, error } = await state.db.from('workspace_invites').select('*').eq('workspace_id', state.workspace.id).order('created_at', { ascending: false }).limit(30);
      if (!error) state.invites = data || [];
      const activeInvites = state.invites.filter(i => !i.accepted_at && new Date(i.expires_at) > new Date());
      invitesHTML = `
        <div class="invite-box brand-box">
          <div><strong>Invite a team member</strong><p class="help">Create a secure, email-locked link. The role is enforced by Supabase RLS, not just the UI.</p></div>
          <form id="invite-form" class="invite-row">
            <input class="input" type="email" name="email" placeholder="member@example.com" required>
            <select class="select" name="role">${roleOptions('developer')}</select>
            <button class="btn brand-primary" type="submit">Create invite</button>
          </form>
          ${activeInvites.length ? `<div class="invite-list">${activeInvites.map(i => `<div class="invite-item"><span>${esc(i.email)} • ${esc(roleLabel(i.role))} • expires ${formatDate(i.expires_at)}</span><div><button class="btn small" data-action="copy-invite" data-token="${i.token}">Copy link</button><button class="btn danger small" data-action="revoke-invite" data-id="${i.id}">Revoke</button></div></div>`).join('')}</div>` : ''}
        </div>`;
    }

    page.innerHTML = `
      <div class="content team-content">
        <div class="page-head branded-page-head">
          <div class="page-icon">👥</div>
          <div class="page-head-copy"><span class="eyebrow">TEAM ACCESS</span><h1 class="page-title">Team & Permissions</h1><p class="page-subtitle">Control who can access ${esc(state.workspace.name)} and exactly what each role can do.</p></div>
        </div>
        ${invitesHTML}
        <section class="team-section">
          <div class="section-heading"><div><h2>Members</h2><p>${state.members.length} team member${state.members.length === 1 ? '' : 's'} • ${state.members.filter(m => isOnline(m.user_id)).length} online now.</p></div></div>
          <div class="team-grid">
            ${state.members.map(m => {
              const p = state.profiles.get(m.user_id) || {};
              const protectedOwner = m.user_id === state.workspace.created_by;
              const canManage = canManageMembers() && !protectedOwner && m.user_id !== state.user.id;
              return `<div class="member-row">
                <div class="member-main">${avatarHTML(m.user_id, 'lg')}<div class="member-copy"><strong>${esc(p.display_name || 'Team member')} ${isOnline(m.user_id) ? '<i class="online-dot"></i>' : ''}</strong><span>${isOnline(m.user_id) ? 'Online now' : 'Offline'} • ${esc(p.email || '')}</span></div></div>
                <div>${canManage ? `<select class="select member-role-select" data-member-role="${m.user_id}">${roleOptions(m.role)}</select>` : pill(`${iconForRole(m.role)} ${roleLabel(m.role)}`, roleClass(m.role))}</div>
                <div>${canManage ? `<button class="btn danger small" data-action="remove-member" data-id="${m.user_id}">Remove</button>` : protectedOwner ? '<span class="owner-lock">Owner locked</span>' : ''}</div>
              </div>`;
            }).join('')}
          </div>
        </section>

        ${isOwner() ? `<section class="team-section roles-section">
          <div class="section-heading"><div><h2>Role permissions</h2><p>Admin and Developer permissions are fully editable by the protected Owner account. Owner itself cannot be weakened or reassigned.</p></div><button class="btn brand-secondary" data-action="new-role">＋ Custom role</button></div>
          <div class="roles-grid">${state.roles.map(rolePermissionEditor).join('')}</div>
        </section>` : ''}
      </div>`;
  }

  function openRoleModal(role = null) {
    if (!isOwner()) return;
    const isNew = !role;
    openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${isNew ? 'New custom role' : `Edit ${esc(role.name)}`}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
        <form id="role-form" data-role="${esc(role?.role_key || '')}">
          <div class="modal-body"><div class="form-grid">
            <div class="field"><label>Role name</label><input class="input" name="name" maxlength="50" value="${esc(role?.name || '')}" placeholder="e.g. Modeler" required></div>
            <div class="field"><label>Role key</label><input class="input" name="role_key" maxlength="32" value="${esc(role?.role_key || '')}" placeholder="e.g. modeler" ${isNew ? '' : 'readonly'} required><span class="help">Lowercase letters, numbers, - and _.</span></div>
            <div class="field span-2"><label>Description</label><input class="input" name="description" value="${esc(role?.description || '')}" placeholder="What this role is for"></div>
            <div class="field"><label>Badge colour</label><select class="select" name="color">${['gray','blue','green','yellow','red','purple','pink'].map(c => `<option value="${c}" ${role?.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          </div></div>
          <div class="modal-actions">
            ${role && !role.is_system ? `<button class="btn danger" type="button" data-action="delete-role" data-role="${esc(role.role_key)}" style="margin-right:auto">Delete role</button>` : ''}
            <button class="btn" type="button" data-action="close-modal">Cancel</button>
            <button class="btn brand-primary" type="submit">Save role</button>
          </div>
        </form>
      </div>`);
  }

  async function saveRole(form) {
    const fd = new FormData(form);
    const existingKey = form.dataset.role || '';
    const roleKey = (existingKey || fd.get('role_key')).trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(roleKey)) throw new Error('Role key must be 2–32 lowercase letters/numbers with - or _.');
    if (roleKey === 'owner') throw new Error('Owner is a protected role.');
    const payload = {
      workspace_id: state.workspace.id,
      role_key: roleKey,
      name: fd.get('name').trim(),
      description: fd.get('description').trim() || null,
      color: fd.get('color') || 'gray'
    };
    let res;
    if (existingKey) res = await state.db.from('workspace_roles').update({ name: payload.name, description: payload.description, color: payload.color }).eq('workspace_id', state.workspace.id).eq('role_key', existingKey);
    else {
      const maxOrder = Math.max(100, ...state.roles.map(r => r.sort_order || 100));
      res = await state.db.from('workspace_roles').insert({ ...payload, permissions: {}, is_system: false, sort_order: maxOrder + 10 });
    }
    if (res.error) throw res.error;
    closeModal();
    await refreshAll(false);
    location.hash = '#team';
  }

  function openModal(html) {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">${html}</div>`;
  }

  function closeModal() {
    modalRoot.innerHTML = '';
  }

  function openItemViewModal(item) {
    const deps = dependencyIds(item).map(id => state.items.find(candidate => candidate.id === id)).filter(Boolean);
    openModal(`
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(item.title)}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
        <div class="modal-body">
          <div class="readonly-task-grid">
            <div><span>Tracker</span><strong>${esc(trackerFor(item.tracker_id)?.name || '—')}</strong></div>
            <div><span>Status</span>${pill(item.status, statusClass(item.status), false)}</div>
            <div><span>Assignee</span><strong>${esc(item.assignee_id ? displayName(item.assignee_id) : 'Unassigned')}</strong></div>
            <div><span>Due date</span><strong>${esc(item.due_date ? formatDate(item.due_date) : '—')}</strong></div>
            <div><span>Priority</span><strong>${esc(item.priority || '—')}</strong></div>
            <div><span>Effort</span><strong>${esc(item.effort_level || '—')}</strong></div>
          </div>
          ${item.description ? `<div class="readonly-description"><span>Description</span><p>${esc(item.description)}</p></div>` : ''}
          ${deps.length ? `<div class="readonly-description"><span>Dependencies</span><div class="dependency-chain">${deps.map(dep => `<button data-action="edit-item" data-id="${dep.id}">${esc(dep.title)} ${pill(dep.status,statusClass(dep.status),false)}</button>`).join('')}</div></div>` : ''}
        </div>
        <div class="modal-actions"><button class="btn primary" type="button" data-action="close-modal">Close</button></div>
      </div>`);
  }

  function openItemModal(item = null, defaults = {}) {
    const trackerId = item?.tracker_id || defaults.trackerId || state.trackers[0]?.id;
    const status = item?.status || defaults.status || 'Ready';
    const selectedDeps = new Set(dependencyIds(item));
    const dependencyOptions = state.items
      .filter(candidate => candidate.id !== item?.id)
      .slice()
      .sort((a,b) => (trackerFor(a.tracker_id)?.name || '').localeCompare(trackerFor(b.tracker_id)?.name || '') || a.title.localeCompare(b.title));
    const blockers = item ? blockedByItems(item) : [];

    openModal(`
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${item ? 'Edit task' : 'New task'}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
        <form id="item-form" data-id="${item?.id || ''}">
          <div class="modal-body">
            ${blockers.length ? `<div class="dependency-warning"><strong>🔒 This task is currently blocked.</strong><span>Waiting on ${esc(blockers.map(b => b.title).join(', '))}</span></div>` : ''}
            <div class="form-grid">
              <div class="field span-2"><label>Title</label><input class="input" name="title" maxlength="180" value="${esc(item?.title || '')}" placeholder="What needs doing?" required autofocus></div>
              <div class="field"><label>Tracker</label><select class="select" name="tracker_id">${state.trackers.map(t => `<option value="${t.id}" ${(trackerId === t.id) ? 'selected' : ''}>${esc(t.icon)} ${esc(t.name)}</option>`).join('')}</select></div>
              <div class="field"><label>Workflow status</label><select class="select" name="status">${allowedStatuses(status).map(s => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
              <div class="field"><label>Assignee</label><select class="select" name="assignee_id"><option value="">Unassigned</option>${state.members.map(m => `<option value="${m.user_id}" ${item?.assignee_id === m.user_id ? 'selected' : ''}>${esc(displayName(m.user_id))}</option>`).join('')}</select></div>
              <div class="field"><label>Due date</label><input class="input" type="date" name="due_date" value="${esc(item?.due_date || '')}"></div>
              <div class="field"><label>Priority</label><select class="select" name="priority"><option value="">None</option>${PRIORITIES.map(p => `<option ${item?.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
              <div class="field"><label>Task type</label><input class="input" name="item_type" value="${esc(item?.item_type || '')}" placeholder="e.g. 🚗 Vehicle"></div>
              <div class="field"><label>Effort</label><select class="select" name="effort_level"><option value="">None</option>${EFFORTS.map(e => `<option ${item?.effort_level === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
              <div class="field"><label>Progress (%)</label><input class="input" type="number" min="0" max="100" name="progress" value="${item?.progress ?? STATUS_PROGRESS[status] ?? 0}"></div>
              <div class="field span-2"><label>Description / notes</label><textarea class="textarea" name="description" placeholder="Add details, links, acceptance notes…">${esc(item?.description || '')}</textarea></div>

              <div class="field span-2 dependency-field">
                <label>Dependencies / blocked by</label>
                <span class="help">Select tasks that must be completed before this task can fully move forward.</span>
                <div class="dependency-picker">
                  ${dependencyOptions.length ? dependencyOptions.map(dep => `
                    <label class="dependency-option ${isComplete(dep) ? 'complete' : ''}">
                      <input type="checkbox" name="dependency_ids" value="${dep.id}" ${selectedDeps.has(dep.id) ? 'checked' : ''}>
                      <span class="dependency-option-copy">
                        <strong>${esc(dep.title)}</strong>
                        <small>${esc(trackerFor(dep.tracker_id)?.name || '')} • ${esc(dep.status)}</small>
                      </span>
                    </label>`).join('') : '<div class="empty-state small">No other tasks are available yet.</div>'}
                </div>
              </div>
            </div>
          </div>
          <div class="modal-actions">
            ${item && canDeleteItems() ? `<button class="btn danger" type="button" data-action="delete-item" data-id="${item.id}" style="margin-right:auto">Delete</button>` : ''}
            <button class="btn" type="button" data-action="close-modal">Cancel</button>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>
      </div>`);
  }

  function openTrackerModal(tracker = null) {
    const settings = tracker?.settings || {};
    openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${tracker ? 'Tracker settings' : 'New tracker'}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
        <form id="tracker-form" data-id="${tracker?.id || ''}">
          <div class="modal-body">
            <div class="form-grid">
              <div class="field"><label>Icon</label><input class="input" name="icon" maxlength="8" value="${esc(tracker?.icon || '📋')}" required></div>
              <div class="field"><label>Name</label><input class="input" name="name" maxlength="100" value="${esc(tracker?.name || '')}" required></div>
              <div class="field span-2"><label>Description</label><input class="input" name="description" value="${esc(tracker?.description || '')}" placeholder="What is this tracker for?"></div>
              <div class="field span-2"><label>Default view</label><select class="select" name="kind"><option value="table" ${tracker?.kind === 'table' ? 'selected' : ''}>Table</option><option value="kanban" ${tracker?.kind === 'kanban' ? 'selected' : ''}>Board / Kanban</option></select></div>

              <div class="field span-2 update-settings-box">
                <label class="toggle-row"><span><strong>Use as current weekly update</strong><small>Powers the Update Command Centre and Ship Room.</small></span><input type="checkbox" name="is_current_update" ${settings.isCurrentUpdate ? 'checked' : ''}></label>
                <div class="form-grid nested">
                  <div class="field"><label>Update display name</label><input class="input" name="update_title" value="${esc(settings.updateTitle || '')}" placeholder="e.g. F1 Update"></div>
                  <div class="field"><label>Release date</label><input class="input" type="date" name="release_date" value="${esc(settings.releaseDate || '')}"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-actions">
            ${tracker && canDeleteTrackers() ? `<button class="btn danger" type="button" data-action="delete-tracker" data-id="${tracker.id}" style="margin-right:auto">Delete tracker</button>` : ''}
            <button class="btn" type="button" data-action="close-modal">Cancel</button>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>
      </div>`);
  }

  async function saveItem(form) {
    const fd = new FormData(form);
    const id = form.dataset.id || null;
    const trackerId = fd.get('tracker_id');
    const status = fd.get('status');

    if (status === 'Approved' && !canApproveItems()) throw new Error('Your role cannot approve tasks.');
    if (status === 'Shipped' && !canShipUpdates()) throw new Error('Your role cannot mark tasks as shipped.');

    const existing = id ? state.items.find(item => item.id === id) : null;
    const customData = { ...(existing?.custom_data || {}) };
    customData.blocked_by = fd.getAll('dependency_ids').filter(depId => depId && depId !== id);

    const payload = {
      workspace_id: state.workspace.id,
      tracker_id: trackerId,
      title: fd.get('title').trim(),
      status,
      assignee_id: fd.get('assignee_id') || null,
      due_date: fd.get('due_date') || null,
      priority: fd.get('priority') || null,
      item_type: fd.get('item_type').trim() || null,
      effort_level: fd.get('effort_level') || null,
      progress: COMPLETE_STATUSES.has(status)
        ? 100
        : Math.max(0, Math.min(100, Number(fd.get('progress') || STATUS_PROGRESS[status] || 0))),
      description: fd.get('description').trim() || null,
      custom_data: customData
    };

    let res;
    if (id) res = await state.db.from('items').update(payload).eq('id', id);
    else {
      const maxOrder = Math.max(0, ...state.items.filter(i => i.tracker_id === trackerId && i.status === status).map(i => i.sort_order || 0));
      res = await state.db.from('items').insert({ ...payload, sort_order: maxOrder + 10, created_by: state.user.id });
    }
    if (res.error) throw res.error;
    closeModal();
    await refreshAll(false);
  }

  async function saveTracker(form) {
    const fd = new FormData(form);
    const id = form.dataset.id || null;
    const existing = id ? state.trackers.find(t => t.id === id) : null;
    const settings = {
      ...(existing?.settings || {}),
      isCurrentUpdate: fd.get('is_current_update') === 'on',
      updateTitle: fd.get('update_title')?.trim() || null,
      releaseDate: fd.get('release_date') || null
    };

    const payload = {
      name: fd.get('name').trim(),
      icon: fd.get('icon').trim() || '📋',
      description: fd.get('description').trim() || null,
      kind: fd.get('kind'),
      settings
    };

    let res;
    if (id) {
      if (settings.isCurrentUpdate) {
        const others = state.trackers.filter(t => t.id !== id && t.settings?.isCurrentUpdate);
        await Promise.all(others.map(t => state.db.from('trackers').update({ settings: { ...(t.settings || {}), isCurrentUpdate: false } }).eq('id', t.id)));
      }
      res = await state.db.from('trackers').update(payload).eq('id', id);
    } else {
      const maxOrder = Math.max(0, ...state.trackers.map(t => t.sort_order || 0));
      res = await state.db.from('trackers').insert({ ...payload, workspace_id: state.workspace.id, sort_order: maxOrder + 10, created_by: state.user.id }).select('id').single();
      if (!res.error && res.data?.id) location.hash = `#tracker/${res.data.id}`;
    }
    if (res.error) throw res.error;
    closeModal();
    await refreshAll(false);
  }

  async function refreshAll(showToast = false) {
    if (!state.workspace) return;
    await loadWorkspaceData();
    routeFromHash();
    renderShell();
    if (showToast) toast('Workspace refreshed.');
  }

  function scheduleRealtimeReload() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(() => refreshAll(false).catch(err => console.error(err)), 250);
  }

  function syncPresenceState() {
    if (!state.realtime) return;
    const raw = state.realtime.presenceState?.() || {};
    const next = new Map();
    Object.values(raw).flat().forEach(meta => {
      if (!meta?.user_id) return;
      const existing = next.get(meta.user_id);
      if (!existing || String(meta.online_at || '') > String(existing.online_at || '')) next.set(meta.user_id, meta);
    });
    state.presence = next;
    if (['home', 'team', 'workload'].includes(state.route)) {
      const page = document.getElementById('page');
      if (page) renderPage();
    }
  }

  async function updatePresence() {
    if (!state.realtime || !state.user || !state.workspace) return;
    try {
      await state.realtime.track({
        user_id: state.user.id,
        display_name: displayName(state.user.id),
        role: myRole(),
        route: state.route,
        online_at: new Date().toISOString()
      });
    } catch (_) {}
  }

  function bindRealtime() {
    if (state.realtime) state.db.removeChannel(state.realtime);
    state.presence = new Map();
    state.realtime = state.db
      .channel(`workspace-${state.workspace.id}`, { config: { presence: { key: state.user.id } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `workspace_id=eq.${state.workspace.id}` }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trackers', filter: `workspace_id=eq.${state.workspace.id}` }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_members', filter: `workspace_id=eq.${state.workspace.id}` }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_roles', filter: `workspace_id=eq.${state.workspace.id}` }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `workspace_id=eq.${state.workspace.id}` }, scheduleRealtimeReload)
      .on('presence', { event: 'sync' }, syncPresenceState)
      .on('presence', { event: 'join' }, syncPresenceState)
      .on('presence', { event: 'leave' }, syncPresenceState)
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await updatePresence();
          syncPresenceState();
        }
      });
  }

  // Global events
  document.addEventListener('click', async (e) => {
    const routeEl = e.target.closest('[data-route]');
    if (routeEl) {
      e.preventDefault();
      location.hash = `#${routeEl.dataset.route}`;
      $('#sidebar')?.classList.remove('open');
      document.body.classList.remove('sidebar-open');
      return;
    }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    try {
      if (action === 'auth-mode') {
        state.authMode = el.dataset.mode;
        renderAuth();
      } else if (action === 'signout') {
        $('#sidebar')?.classList.remove('open');
        document.body.classList.remove('sidebar-open');
        await clearReminderTasks();
        await state.db.auth.signOut();
      } else if (action === 'toggle-sidebar') {
        const sidebar = $('#sidebar');
        const isOpen = sidebar?.classList.toggle('open');
        document.body.classList.toggle('sidebar-open', Boolean(isOpen));
      } else if (action === 'close-sidebar') {
        $('#sidebar')?.classList.remove('open');
        document.body.classList.remove('sidebar-open');
      } else if (action === 'refresh') {
        await refreshAll(true);
      } else if (action === 'new-item') {
        if (canCreateItems()) openItemModal(null, { trackerId: el.dataset.tracker, status: el.dataset.status });
      } else if (action === 'edit-item') {
        const item = state.items.find(i => i.id === el.dataset.id);
        if (item) {
          if (canEditItems()) openItemModal(item);
          else openItemViewModal(item);
        }
      } else if (action === 'new-tracker') {
        if (canCreateTrackers()) openTrackerModal();
      } else if (action === 'edit-tracker') {
        const tracker = state.trackers.find(t => t.id === el.dataset.id);
        if (tracker && canEditTrackers()) openTrackerModal(tracker);
      } else if (action === 'enable-notifications') {
        await requestNotifications();
      } else if (action === 'install-pwa') {
        await installPwa();
      } else if (action === 'refresh-memberships') {
        await bootUser();
      } else if (action === 'new-role') {
        openRoleModal();
      } else if (action === 'edit-role') {
        const role = roleForKey(el.dataset.role);
        if (role) openRoleModal(role);
      } else if (action === 'save-role-permissions') {
        if (!isOwner()) return;
        const roleKey = el.dataset.role;
        if (roleKey === 'owner') return;
        const permissions = {};
        ROLE_PERMISSIONS.forEach(([key]) => {
          permissions[key] = Boolean(document.querySelector(`[data-role-perm="${roleKey}"][data-permission="${key}"]`)?.checked);
        });
        const { error } = await state.db.from('workspace_roles').update({ permissions }).eq('workspace_id', state.workspace.id).eq('role_key', roleKey);
        if (error) throw error;
        toast(`${roleLabel(roleKey)} permissions saved.`);
        await refreshAll(false);
        location.hash = '#team';
      } else if (action === 'delete-role') {
        if (!isOwner()) return;
        const roleKey = el.dataset.role;
        const role = roleForKey(roleKey);
        if (role && !role.is_system && confirm(`Delete the “${role.name}” role? It cannot be in use by a member or invite.`)) {
          const { error } = await state.db.from('workspace_roles').delete().eq('workspace_id', state.workspace.id).eq('role_key', roleKey);
          if (error) throw error;
          closeModal();
          await refreshAll(false);
          location.hash = '#team';
        }
      } else if (action === 'close-modal') {
        closeModal();
      } else if (action === 'modal-backdrop' && e.target === el) {
        closeModal();
      } else if (action === 'switch-view') {
        state.viewOverrides[el.dataset.id] = el.dataset.view;
        renderPage();
      } else if (action === 'toggle-my-tasks') {
        state.tableFilter[el.dataset.id] = state.tableFilter[el.dataset.id] === 'mine' ? 'all' : 'mine';
        renderPage();
      } else if (action === 'delete-item') {
        if (!canDeleteItems()) return;
        const item = state.items.find(i => i.id === el.dataset.id);
        if (item && confirm(`Delete “${item.title}”?`)) {
          const { error } = await state.db.from('items').delete().eq('id', item.id);
          if (error) throw error;
          closeModal();
          await refreshAll(false);
        }
      } else if (action === 'delete-tracker') {
        if (!canDeleteTrackers()) return;
        const tracker = state.trackers.find(t => t.id === el.dataset.id);
        if (tracker && confirm(`Delete “${tracker.name}” and every task inside it?`)) {
          const { error } = await state.db.from('trackers').delete().eq('id', tracker.id);
          if (error) throw error;
          closeModal();
          location.hash = '#home';
          await refreshAll(false);
        }
      } else if (action === 'copy-invite') {
        const base = `${location.origin}${location.pathname}`;
        await navigator.clipboard.writeText(`${base}?invite=${el.dataset.token}`);
        toast('Invite link copied.');
      } else if (action === 'revoke-invite') {
        if (!canInviteMembers()) return;
        if (confirm('Revoke this invite?')) {
          const { error } = await state.db.from('workspace_invites').delete().eq('id', el.dataset.id);
          if (error) throw error;
          renderTeam(document.getElementById('page'));
        }
      } else if (action === 'mark-all-notifications') {
        const read = readNotificationIds();
        buildNotifications().forEach(n => read.add(n.id));
        saveReadNotificationIds(read);
        renderShell();
      } else if (action === 'open-notification') {
        if (el.dataset.notification) markNotificationRead(el.dataset.notification);
        const item = state.items.find(i => i.id === el.dataset.id);
        if (item) {
          if (canEditItems()) openItemModal(item);
          else openItemViewModal(item);
        } else renderShell();
      } else if (action === 'export-calendar') {
        const entries = calendarEntries();
        if (entries.length) downloadCalendar(entries);
      } else if (action === 'export-calendar-event') {
        const event = calendarEntries().find(entry => entry.id === el.dataset.calendarId);
        if (event) downloadCalendar([event], `${event.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'boxed-up-event'}.ics`);
      } else if (action === 'google-calendar') {
        const event = calendarEntries().find(entry => entry.id === el.dataset.calendarId);
        if (event) window.open(googleCalendarUrl(event), '_blank', 'noopener,noreferrer');
      } else if (action === 'ship-stage') {
        if (!canShipUpdates()) throw new Error('Your role cannot operate Ship Room controls.');
        const tracker = currentUpdateTracker();
        if (!tracker) throw new Error('No current update is configured.');
        const stage = el.dataset.stage;
        const items = currentUpdateItems();
        const blockers = items.filter(isBlocked);
        if (stage === 'release-candidate' && blockers.length) throw new Error('Clear all dependency blockers before marking a release candidate.');
        if (stage === 'approved' && (!items.length || !items.every(item => ['Testing','Approved','Shipped'].includes(item.status)))) {
          throw new Error('Every release task must be in Testing, Approved or Shipped before approving the update.');
        }
        const settings = { ...(tracker.settings || {}), shipStage: stage };
        const { error } = await state.db.from('trackers').update({ settings }).eq('id', tracker.id);
        if (error) throw error;
        toast(`${shipStageLabel(stage)} stage set.`);
        await refreshAll(false);
      } else if (action === 'ship-update') {
        if (!canShipUpdates()) throw new Error('Your role cannot ship updates.');
        const tracker = currentUpdateTracker();
        if (!tracker) throw new Error('No current update is configured.');
        if (tracker.settings?.shipStage === 'shipped') {
          toast('This update is already marked as shipped.');
          return;
        }
        const items = currentUpdateItems();
        if (!items.length) throw new Error('The current update has no tasks.');
        if (items.some(isBlocked)) throw new Error('Resolve all dependency blockers before shipping.');
        if (!items.every(item => ['Approved','Shipped'].includes(item.status))) throw new Error('Every update task must be Approved before shipping.');
        if (!confirm(`Ship “${updateTitle()}” now? This marks all approved release tasks as Shipped.`)) return;
        const results = await Promise.all(items.filter(item => item.status === 'Approved').map(item =>
          state.db.from('items').update({ status: 'Shipped', progress: 100 }).eq('id', item.id)
        ));
        const failed = results.find(result => result.error);
        if (failed) throw failed.error;
        const settings = { ...(tracker.settings || {}), shipStage: 'shipped', shippedAt: new Date().toISOString() };
        const { error } = await state.db.from('trackers').update({ settings }).eq('id', tracker.id);
        if (error) throw error;
        toast('🚀 Update shipped.');
        await refreshAll(false);
      } else if (action === 'remove-member') {
        if (!canManageMembers()) return;
        const name = displayName(el.dataset.id);
        if (confirm(`Remove ${name} from the workspace?`)) {
          const { error } = await state.db.from('workspace_members').delete().eq('workspace_id', state.workspace.id).eq('user_id', el.dataset.id);
          if (error) throw error;
          await refreshAll(false);
        }
      }
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'error');
    }
  });

  document.addEventListener('change', async (e) => {
    try {
      if (e.target.matches('[data-inline-status]')) {
        const id = e.target.dataset.inlineStatus;
        const status = e.target.value;
        const item = state.items.find(i => i.id === id);
        if (status === 'Approved' && !canApproveItems()) throw new Error('Your role cannot approve tasks.');
        if (status === 'Shipped' && !canShipUpdates()) throw new Error('Your role cannot mark tasks as shipped.');
        if (item && ['Approved','Shipped'].includes(status) && isBlocked(item)) throw new Error('Resolve this task’s dependencies before approving or shipping it.');
        const payload = { status };
        if (COMPLETE_STATUSES.has(status)) payload.progress = 100;
        const { error } = await state.db.from('items').update(payload).eq('id', id);
        if (error) throw error;
        if (item) Object.assign(item, payload);
      }

      if (e.target.matches('[data-member-role]')) {
        if (!canManageMembers()) return;
        const userId = e.target.dataset.memberRole;
        const role = e.target.value;
        if (role === 'owner') throw new Error('Owner is protected and cannot be assigned.');
        const { error } = await state.db.from('workspace_members').update({ role }).eq('workspace_id', state.workspace.id).eq('user_id', userId);
        if (error) throw error;
        await refreshAll(false);
      }
    } catch (err) {
      toast(err.message, 'error');
      await refreshAll(false);
    }
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    try {
      if (form.id === 'auth-form') {
        const fd = new FormData(form);
        const email = fd.get('email').trim();
        const password = fd.get('password');
        if (state.authMode === 'login') {
          const { error } = await state.db.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          const redirect = `${location.origin}${location.pathname}${location.search}`;
          const { data, error } = await state.db.auth.signUp({
            email,
            password,
            options: {
              data: { display_name: fd.get('display_name').trim() },
              emailRedirectTo: redirect
            }
          });
          if (error) throw error;
          if (!data.session) {
            renderAuth('Account created. Check your email to confirm it, then come back to this page.');
          }
        }
      }

      if (form.id === 'workspace-form') {
        const fd = new FormData(form);
        const { data, error } = await state.db.rpc('create_boxed_up_workspace', { p_name: fd.get('name').trim() });
        if (error) throw error;
        localStorage.setItem('boxed-up-workspace', data);
        await bootUser();
        toast('Boxed Up HQ created.');
      }

      if (form.id === 'item-form') await saveItem(form);
      if (form.id === 'tracker-form') await saveTracker(form);
      if (form.id === 'role-form') await saveRole(form);

      if (form.id === 'invite-form') {
        if (!canInviteMembers()) throw new Error('Your role cannot invite members.');
        const fd = new FormData(form);
        const payload = {
          workspace_id: state.workspace.id,
          email: fd.get('email').trim().toLowerCase(),
          role: fd.get('role'),
          invited_by: state.user.id
        };
        const { data, error } = await state.db.from('workspace_invites').insert(payload).select('token').single();
        if (error) throw error;
        form.reset();
        const base = `${location.origin}${location.pathname}`;
        const url = `${base}?invite=${data.token}`;
        try { await navigator.clipboard.writeText(url); } catch (_) {}
        toast('Invite created — link copied.');
        renderTeam(document.getElementById('page'));
      }
    } catch (err) {
      console.error(err);
      if (form.id === 'auth-form') renderAuth(err.message);
      else if (form.id === 'workspace-form') renderWorkspaceOnboarding(err.message);
      else toast(err.message || String(err), 'error');
    }
  });

  window.addEventListener('hashchange', () => {
    routeFromHash();
    if (state.workspace) {
      renderShell();
      updatePresence().catch(() => {});
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  window.addEventListener('focus', () => {
    syncReminderTasks().catch(console.error);
    updatePresence().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncReminderTasks().catch(console.error);
      updatePresence().catch(() => {});
    }
  });

  init();
})();
