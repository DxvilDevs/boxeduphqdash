(() => {
  'use strict';

  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  const config = window.BOXED_UP_CONFIG || {};
  const supabaseKey = config.SUPABASE_KEY || config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
  const OWNER_EMAIL = 'dxvil6354@gmail.com';
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  const STATUS = ['Not started', 'In progress', 'Done'];
  const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
  const EFFORTS = ['Small', 'Medium', 'Large'];
  const ROLE_PERMISSIONS = [
    ['items.create', 'Create tasks', 'Add new tasks/issues/projects'],
    ['items.edit', 'Edit tasks', 'Edit fields, status and move cards'],
    ['items.delete', 'Delete tasks', 'Permanently delete tasks'],
    ['trackers.create', 'Create trackers', 'Add new databases / boards'],
    ['trackers.edit', 'Edit trackers', 'Rename, reorder and change tracker views'],
    ['trackers.delete', 'Delete trackers', 'Delete a tracker and its tasks'],
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
    presence: new Map(),
    invites: [],
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
    return status === 'In progress' ? 'blue' : status === 'Done' ? 'green' : 'gray';
  }


  function itemChecklist(item) {
    const raw = item?.checklist;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => ({
        id: String(entry.id || ''),
        text: String(entry.text || '').trim(),
        done: entry.done === true
      }))
      .filter(entry => entry.text);
  }

  function checklistProgress(checklist, status = 'Not started') {
    const list = Array.isArray(checklist) ? checklist : [];
    if (!list.length) return status === 'Done' ? 100 : 0;
    const completed = list.filter(entry => entry.done === true).length;
    return Math.round((completed / list.length) * 100);
  }

  function itemProgress(item) {
    return checklistProgress(itemChecklist(item), item?.status || 'Not started');
  }

  function checklistId() {
    return globalThis.crypto?.randomUUID?.() || `check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function checklistRow(entry = {}) {
    const id = String(entry.id || checklistId());
    return `<div class="checklist-row" data-checklist-row data-checklist-id="${esc(id)}">
      <label class="checklist-check" title="Mark complete"><input type="checkbox" data-checklist-done ${entry.done ? 'checked' : ''}><span></span></label>
      <input class="input checklist-text" data-checklist-text value="${esc(entry.text || '')}" placeholder="Checklist item">
      <button class="icon-btn checklist-remove" type="button" data-action="remove-checklist-item" aria-label="Remove checklist item">×</button>
    </div>`;
  }

  function readChecklist(form) {
    return [...form.querySelectorAll('[data-checklist-row]')]
      .map(row => ({
        id: row.dataset.checklistId || checklistId(),
        text: row.querySelector('[data-checklist-text]')?.value.trim() || '',
        done: Boolean(row.querySelector('[data-checklist-done]')?.checked)
      }))
      .filter(entry => entry.text);
  }

  function updateChecklistPreview(form = document.getElementById('item-form')) {
    if (!form) return;
    const checklist = readChecklist(form);
    const status = form.elements.status?.value || 'Not started';
    const progress = checklistProgress(checklist, status);
    const completed = checklist.filter(entry => entry.done).length;
    const bar = form.querySelector('[data-checklist-progress-bar]');
    const label = form.querySelector('[data-checklist-progress-label]');
    const count = form.querySelector('[data-checklist-count]');
    if (bar) bar.style.width = `${progress}%`;
    if (label) label.textContent = `${progress}%`;
    if (count) count.textContent = checklist.length ? `${completed} of ${checklist.length} complete` : 'No checklist items yet';
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
    if (status === 'Done') return 'Closed';
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

  function trackerFor(id) {
    return state.trackers.find(t => t.id === id) || null;
  }

  function daysUntil(dateValue) {
    if (!dateValue) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  function dueLabel(item) {
    if (!item?.due_date) return 'No due date';
    const days = daysUntil(item.due_date);
    if (days === null) return formatDate(item.due_date);
    if (days < 0) return `${Math.abs(days)}d overdue`;
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    if (days <= 7) return `Due in ${days}d`;
    return formatDate(item.due_date);
  }

  function isOnline(userId) {
    return state.presence.has(userId);
  }

  function presenceLabel(userId) {
    return isOnline(userId)
      ? '<span class="presence-status online"><i class="online-dot"></i>Online</span>'
      : '<span class="presence-status offline"><i class="offline-dot"></i>Offline</span>';
  }

  function activityActor(entry) {
    return entry?.actor_id ? displayName(entry.actor_id) : 'Boxed Up HQ';
  }

  function activityIcon(entry) {
    if (entry.entity_type === 'member') return '👥';
    if (entry.entity_type === 'tracker') return '📋';
    if (entry.action === 'created') return '＋';
    if (entry.action === 'deleted') return '🗑️';
    if (entry.action === 'status_changed') return '➜';
    if (entry.action === 'assigned') return '👤';
    if (entry.action === 'due_date_changed') return '📅';
    return '✎';
  }

  function activityDescription(entry) {
    const title = entry?.entity_title || 'an item';
    const meta = entry?.metadata || {};
    if (entry.entity_type === 'member') {
      const target = meta.user_id ? displayName(meta.user_id) : 'a team member';
      if (entry.action === 'member_joined') return entry.actor_id === meta.user_id ? 'joined the workspace' : `added ${target} to the workspace`;
      if (entry.action === 'member_removed') return `removed ${target} from the workspace`;
      if (entry.action === 'role_changed') return `changed ${target}'s role from ${roleLabel(meta.from_role)} to ${roleLabel(meta.to_role)}`;
    }
    if (entry.entity_type === 'tracker') {
      if (entry.action === 'created') return `created the ${title} tracker`;
      if (entry.action === 'deleted') return `deleted the ${title} tracker`;
      return `updated the ${title} tracker`;
    }
    if (entry.action === 'created') return `created ${title}`;
    if (entry.action === 'deleted') return `deleted ${title}`;
    if (entry.action === 'status_changed') return `moved ${title} from ${meta.from_status || '—'} to ${meta.to_status || '—'}`;
    if (entry.action === 'assigned') {
      if (!meta.assignee_id) return `unassigned ${title}`;
      return `assigned ${title} to ${displayName(meta.assignee_id)}`;
    }
    if (entry.action === 'due_date_changed') return `changed the due date on ${title}`;
    return `updated ${title}`;
  }

  function workCard(item) {
    const tracker = trackerFor(item.tracker_id);
    const dueDays = daysUntil(item.due_date);
    return `<article class="work-card" data-action="edit-item" data-id="${item.id}">
      <div class="work-card-main">
        <div class="work-card-title">${esc(item.title)}</div>
        <div class="work-card-meta">
          ${tracker ? `<span>${esc(tracker.icon)} ${esc(tracker.name)}</span>` : ''}
          ${item.due_date ? `<span class="${dueDays !== null && dueDays < 0 && item.status !== 'Done' ? 'overdue-text' : ''}">${esc(dueLabel(item))}</span>` : '<span>No due date</span>'}
        </div>
      </div>
      <div class="work-card-tags">
        ${pill(item.status, statusClass(item.status), false)}
        ${item.priority ? pill(item.priority, priorityClass(item.priority)) : ''}
      </div>
    </article>`;
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
    renderPage();
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
      .filter(item => item.assignee_id === state.user.id && item.status !== 'Done' && item.due_date)
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
    if (['home', 'my-work', 'activity', 'team'].includes(hash)) state.route = hash;
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
    if (state.route === 'my-work') return 'My Work';
    if (state.route === 'activity') return 'Studio Feed';
    if (state.route === 'team') return 'Team & Permissions';
    return 'Boxed Up HQ';
  }

  function renderShell() {
    if (!state.user || !state.workspace) return;
    const me = state.profiles.get(state.user.id) || { email: state.user.email, display_name: state.user.user_metadata?.display_name };
    const breadcrumb = routeLabel();
    const role = roleLabel(myRole());
    const notification = notificationState();
    const myOpen = state.items.filter(i => i.assignee_id === state.user.id && i.status !== 'Done').length;

    app.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar" id="sidebar">
          <div class="workspace-switcher" data-route="home">
            ${brandLogoHTML('ws-icon brand-image')}
            <span class="workspace-name">BOXED UP HQ</span>
            <span class="workspace-caret">⌄</span>
          </div>
          <div class="sidebar-scroll">
            <button class="nav-item ${state.route === 'home' ? 'active' : ''}" data-route="home">
              <span class="nav-icon">⌂</span><span class="nav-text">HQ Overview</span>
            </button>
            <button class="nav-item ${state.route === 'my-work' ? 'active' : ''}" data-route="my-work">
              <span class="nav-icon">◎</span><span class="nav-text">My Work</span>${myOpen ? `<span class="nav-badge">${myOpen}</span>` : ''}
            </button>
            <button class="nav-item ${state.route === 'activity' ? 'active' : ''}" data-route="activity">
              <span class="nav-icon">📡</span><span class="nav-text">Studio Feed</span>
            </button>
            <div class="side-label">Production</div>
            <div id="tracker-nav">
              ${state.trackers.map(t => `
                <button class="nav-item ${state.route === `tracker/${t.id}` ? 'active' : ''}" data-route="tracker/${t.id}" data-tracker-nav="${t.id}">
                  <span class="nav-icon">${esc(t.icon)}</span><span class="nav-text">${esc(t.name)}</span>${canEditTrackers() ? '<span class="nav-drag">⋮⋮</span>' : ''}
                </button>`).join('')}
            </div>
            ${canCreateTrackers() ? `<button class="nav-item new-tracker" data-action="new-tracker"><span class="nav-icon">＋</span><span class="nav-text">New tracker</span></button>` : ''}
            <div class="side-label">Workspace</div>
            <button class="nav-item ${state.route === 'team' ? 'active' : ''}" data-route="team"><span class="nav-icon">👥</span><span class="nav-text">Team & Permissions</span></button>
            <button class="nav-item install-action" data-action="install-pwa"><span class="nav-icon">⬇</span><span class="nav-text">Install HQ app</span></button>
            ${notification !== 'granted' && notification !== 'unsupported' ? `<button class="nav-item" data-action="enable-notifications"><span class="nav-icon">🔔</span><span class="nav-text">Enable reminders</span></button>` : ''}
          </div>
          <div class="sidebar-footer">
            <div class="user-row">
              <span class="avatar-presence-wrap">${avatarHTML(state.user.id)}<i class="online-dot avatar-presence-dot"></i></span>
              <div class="user-details"><div class="user-name">${esc(me.display_name || 'Team member')}</div><div class="user-email">${esc(role)} • ${esc(me.email || state.user.email || '')}</div></div>
              <button class="icon-btn sidebar-signout" title="Sign out" data-action="signout">↪</button>
            </div>
          </div>
        </aside>
        <button class="sidebar-backdrop" aria-label="Close menu" data-action="close-sidebar"></button>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn mobile-toggle" data-action="toggle-sidebar">☰</button>
            ${brandLogoHTML('topbar-logo')}
            <div class="breadcrumb"><strong>${esc(state.workspace.name)}</strong><span>/</span>${esc(breadcrumb)}</div>
            <div class="top-actions">
              <button class="top-chip install-action" data-action="install-pwa">Install app</button>
              ${notification !== 'granted' && notification !== 'unsupported' ? `<button class="top-chip" data-action="enable-notifications">🔔 Reminders</button>` : ''}
              <button class="icon-btn" title="Team" data-route="team">👥</button>
              <button class="icon-btn" title="Refresh" data-action="refresh">↻</button>
              <button class="icon-btn mobile-signout" title="Sign out" aria-label="Sign out" data-action="signout">↪</button>
            </div>
          </header>
          <div class="kraft-stage"><div id="page" class="workspace-page"></div></div>
          <nav class="mobile-dock" aria-label="Mobile navigation">
            <button data-route="home"><span>⌂</span><small>Home</small></button>
            <button data-route="my-work"><span>◎</span><small>My Work</small></button>
            ${canCreateItems() && state.trackers[0] ? `<button class="dock-add" data-action="new-item" data-tracker="${state.trackers[0].id}" data-status="Not started"><span>＋</span><small>Add</small></button>` : '<button data-action="toggle-sidebar"><span>☰</span><small>Trackers</small></button>'}
            <button data-route="activity"><span>📡</span><small>Feed</small></button>
            <button data-action="signout"><span>↪</span><small>Log out</small></button>
          </nav>
        </main>
      </div>`;

    renderPage();
    bindSidebarSortable();
  }

  function renderPage() {
    const page = document.getElementById('page');
    if (!page) return;
    if (state.route === 'my-work') {
      renderMyWork(page);
      return;
    }
    if (state.route === 'activity') {
      renderActivity(page);
      return;
    }
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

  function renderDashboard(page) {
    const myName = state.profiles.get(state.user.id)?.display_name || state.user.user_metadata?.display_name || 'team';
    const total = state.items.length;
    const done = state.items.filter(i => i.status === 'Done').length;
    const inProgress = state.items.filter(i => i.status === 'In progress').length;
    const issueTracker = state.trackers.find(t => /issue/i.test(t.name));
    const issuesOpen = issueTracker ? state.items.filter(i => i.tracker_id === issueTracker.id && i.status !== 'Done').length : 0;
    const due = nextDueSummary();
    const notify = notificationState();
    const dueCopy = !due ? 'Nothing assigned to you has a due date.'
      : due.days < 0 ? `${due.title} is ${Math.abs(due.days)} day${Math.abs(due.days) === 1 ? '' : 's'} overdue.`
      : due.days === 0 ? `${due.title} is due today.`
      : due.days === 1 ? `${due.title} is due tomorrow.`
      : `${due.title} is due in ${due.days} days.`;

    page.innerHTML = `
      <div class="content dashboard-content">
        <section class="hq-hero">
          <div class="hero-copy">
            <span class="eyebrow dark">• BOXED UP GAMES PRODUCTION</span>
            <h1>Work,<br><span>Delivered.</span></h1>
            <div class="hero-actions">
              ${canCreateItems() && state.trackers[0] ? `<button class="btn brand-primary" data-action="new-item" data-tracker="${state.trackers[0].id}" data-status="Not started">＋ Add a task</button>` : ''}
            </div>
          </div>
          <div class="ship-card">
            <span class="tape tape-top"></span><span class="tape tape-bottom"></span>
            <span class="approval-stamp">APPROVED<br>FOR SHIP</span>
            ${brandLogoHTML('ship-logo')}
            <div class="ship-line"></div>
            <strong>BOXED UP HQ • EST. 2026</strong>
          </div>
        </section>


        <section class="reminder-card ${due && due.days <= 1 ? 'urgent' : ''}">
          <div class="reminder-icon">🔔</div>
          <div class="reminder-copy"><strong>Your next deadline</strong><span>${esc(dueCopy)}</span></div>
          ${notify === 'granted' ? `<span class="pill green no-dot">Reminders on</span>` : notify === 'unsupported' ? `<span class="pill gray no-dot">Unsupported</span>` : `<button class="btn brand-primary small" data-action="enable-notifications">Enable notifications</button>`}
        </section>

        <div class="section-kicker">• THE WORKSPACE</div>
        <h2 class="catalog-title">What's In The Box</h2>
        <div class="dashboard-grid">
          <section>
            <h3 class="section-title">Production trackers</h3>
            <div class="resource-list">
              ${state.trackers.slice(0, 8).map(t => `<button class="resource-card tracker-resource" data-route="tracker/${t.id}"><span class="resource-icon">${esc(t.icon)}</span><div><strong>${esc(t.name)}</strong><div class="help">${esc(t.description || (t.kind === 'kanban' ? 'Project board' : 'Task database'))}</div></div><span class="resource-arrow">→</span></button>`).join('')}
            </div>
          </section>
          <section>
            <div class="section-title-row"><h3 class="section-title">Team</h3><button class="text-link" data-route="team">${state.members.filter(m => isOnline(m.user_id)).length} online →</button></div>
            <div class="resource-list">
              ${state.members.slice().sort((a,b) => Number(isOnline(b.user_id)) - Number(isOnline(a.user_id))).slice(0, 8).map(m => `<div class="resource-card team-resource"><span class="avatar-presence-wrap">${avatarHTML(m.user_id, 'lg')}<i class="${isOnline(m.user_id) ? 'online-dot' : 'offline-dot'} avatar-presence-dot"></i></span><div><strong>${esc(displayName(m.user_id))}</strong><div class="help team-status-line">${presenceLabel(m.user_id)} <span>•</span> ${iconForRole(m.role)} ${esc(roleLabel(m.role))}</div></div></div>`).join('')}
            </div>
          </section>
        </div>
      </div>`;
  }

  function renderMyWork(page) {
    const mine = state.items.filter(item => item.assignee_id === state.user.id);
    const open = mine.filter(item => item.status !== 'Done');
    const overdue = open.filter(item => {
      const days = daysUntil(item.due_date);
      return days !== null && days < 0;
    }).sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
    const inProgress = open.filter(item => item.status === 'In progress' && !overdue.includes(item))
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    const notStarted = open.filter(item => item.status === 'Not started' && !overdue.includes(item))
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    const done = mine.filter(item => item.status === 'Done')
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
      .slice(0, 8);
    const dueThisWeek = open.filter(item => {
      const days = daysUntil(item.due_date);
      return days !== null && days >= 0 && days <= 7;
    }).length;
    const defaultTracker = state.trackers.find(t => /overarching|to-do|todo/i.test(t.name)) || state.trackers[0];

    const section = (title, subtitle, items, empty) => `
      <section class="my-work-section">
        <div class="section-heading compact"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>
        <div class="work-list">${items.map(workCard).join('') || `<div class="empty-state small">${esc(empty)}</div>`}</div>
      </section>`;

    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">YOUR TASKS</span><h1>My Work</h1><p>Tasks assigned to you across every tracker.</p></div>
          ${canCreateItems() && defaultTracker ? `<button class="btn brand-primary" data-action="new-item" data-tracker="${defaultTracker.id}" data-status="Not started">＋ New task</button>` : ''}
        </div>
        <div class="quick-stat-row">
          <div><strong>${open.length}</strong><span>Open</span></div>
          <div><strong>${inProgress.length}</strong><span>In progress</span></div>
          <div><strong>${dueThisWeek}</strong><span>Due this week</span></div>
          <div class="${overdue.length ? 'danger-stat' : ''}"><strong>${overdue.length}</strong><span>Overdue</span></div>
        </div>
        <div class="my-work-grid">
          ${section('Overdue', 'Needs attention first', overdue, 'Nothing overdue.')}
          ${section('In progress', 'Work you have already started', inProgress, 'Nothing in progress.')}
          ${section('Not started', 'Your remaining queue', notStarted, 'Nothing waiting to be started.')}
          ${section('Recently done', 'Your latest completed work', done, 'No completed tasks yet.')}
        </div>
      </div>`;
  }

  function renderActivity(page) {
    const online = state.members.filter(m => isOnline(m.user_id));
    page.innerHTML = `
      <div class="content feature-page">
        <div class="feature-head">
          <div><span class="eyebrow">STUDIO ACTIVITY</span><h1>Studio Feed</h1><p>Recent task, tracker and team changes.</p></div>
          <div class="feed-online-summary"><span class="online-dot"></span><strong>${online.length}</strong> online</div>
        </div>
        ${!state.activityAvailable ? '<div class="info-box">The Studio Feed database update still needs to be applied in Supabase.</div>' : ''}
        <div class="activity-feed">
          ${state.activity.map(entry => {
            const item = entry.entity_type === 'item' ? state.items.find(i => i.id === entry.entity_id) : null;
            const tracker = item ? trackerFor(item.tracker_id) : null;
            return `<article class="activity-row">
              <div class="activity-avatar">${entry.actor_id ? avatarHTML(entry.actor_id) : '<span class="avatar sm">HQ</span>'}</div>
              <div class="activity-copy">
                <div><strong>${esc(activityActor(entry))}</strong> ${esc(activityDescription(entry))}</div>
                <span>${formatDate(entry.created_at, true)}${tracker ? ` • ${esc(tracker.name)}` : ''}</span>
              </div>
              <div class="activity-type">${activityIcon(entry)}</div>
            </article>`;
          }).join('') || '<div class="empty-state feed-empty">No activity yet. New changes will appear here automatically.</div>'}
        </div>
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
          ${canCreateItems() ? `<button class="new-btn" data-action="new-item" data-tracker="${tracker.id}" data-status="Not started">New⌄</button>` : ''}
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
          ${canCreateItems() ? `<tr class="new-row" data-action="new-item" data-tracker="${tracker.id}" data-status="Not started"><td colspan="9">＋ &nbsp; New ${preset === 'issues' ? 'issue' : 'task'}</td></tr>` : ''}
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
    return `<span class="pill ${statusClass(item.status)} no-dot"><select class="inline-select" data-inline-status="${item.id}">${STATUS.map(s => `<option ${s === item.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></span>`;
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
    const checklist = itemChecklist(item);
    const progress = itemProgress(item);
    const completed = checklist.filter(entry => entry.done).length;
    return `<article class="kanban-card" data-item-id="${item.id}" data-action="edit-item" data-id="${item.id}">
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-meta">
        ${item.assignee_id ? `${avatarHTML(item.assignee_id)} <span>${esc(displayName(item.assignee_id))}</span>` : '<span>Unassigned</span>'}
        ${item.priority ? pill(item.priority, priorityClass(item.priority)) : ''}
      </div>
      <div class="progress"><span style="width:${progress}%"></span></div>
      <div class="help checklist-card-progress" style="margin-top:5px">${checklist.length ? `${completed}/${checklist.length} complete · ` : ''}${progress}%</div>
    </article>`;
  }

  function bindKanbanSortable(trackerId) {
    $$('[data-kanban-list]').forEach(list => {
      new Sortable(list, {
        group: `tracker-${trackerId}`,
        animation: 150,
        ghostClass: 'sortable-ghost',
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
                updates.push(state.db.from('items').update({
                  status,
                  sort_order: item.sort_order
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
        const results = await Promise.all(ids.map((id, index) => state.db.from('trackers').update({ sort_order: (index + 1) * 10 }).eq('id', id)));
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
          <div class="section-heading"><div><h2>Members</h2><p>${state.members.length} team member${state.members.length === 1 ? '' : 's'} currently have access.</p></div></div>
          <div class="team-grid">
            ${state.members.map(m => {
              const p = state.profiles.get(m.user_id) || {};
              const protectedOwner = m.user_id === state.workspace.created_by;
              const canManage = canManageMembers() && !protectedOwner && m.user_id !== state.user.id;
              return `<div class="member-row">
                <div class="member-main"><span class="avatar-presence-wrap">${avatarHTML(m.user_id, 'lg')}<i class="${isOnline(m.user_id) ? 'online-dot' : 'offline-dot'} avatar-presence-dot"></i></span><div class="member-copy"><strong>${esc(p.display_name || 'Team member')}</strong><span>${esc(p.email || '')}</span>${presenceLabel(m.user_id)}</div></div>
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

  function openItemModal(item = null, defaults = {}) {
    const trackerId = item?.tracker_id || defaults.trackerId || state.trackers[0]?.id;
    const status = item?.status || defaults.status || 'Not started';
    openModal(`
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${item ? 'Edit task' : 'New task'}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
        <form id="item-form" data-id="${item?.id || ''}">
          <div class="modal-body"><div class="form-grid">
            <div class="field span-2"><label>Title</label><input class="input" name="title" maxlength="180" value="${esc(item?.title || '')}" placeholder="What needs doing?" required autofocus></div>
            <div class="field"><label>Tracker</label><select class="select" name="tracker_id">${state.trackers.map(t => `<option value="${t.id}" ${(trackerId === t.id) ? 'selected' : ''}>${esc(t.icon)} ${esc(t.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Status</label><select class="select" name="status">${STATUS.map(s => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <div class="field"><label>Assignee</label><select class="select" name="assignee_id"><option value="">Unassigned</option>${state.members.map(m => `<option value="${m.user_id}" ${item?.assignee_id === m.user_id ? 'selected' : ''}>${esc(displayName(m.user_id))}</option>`).join('')}</select></div>
            <div class="field"><label>Due date</label><input class="input" type="date" name="due_date" value="${esc(item?.due_date || '')}"></div>
            <div class="field"><label>Priority</label><select class="select" name="priority"><option value="">None</option>${PRIORITIES.map(p => `<option ${item?.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
            <div class="field"><label>Task type</label><input class="input" name="item_type" value="${esc(item?.item_type || '')}" placeholder="e.g. 🚗 Vehicle"></div>
            <div class="field"><label>Effort</label><select class="select" name="effort_level"><option value="">None</option>${EFFORTS.map(e => `<option ${item?.effort_level === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
            <div class="field span-2 checklist-field">
              <div class="checklist-heading"><label>To-do checklist</label><span class="checklist-percent" data-checklist-progress-label>${itemProgress(item || { status })}%</span></div>
              <div class="checklist-progress-wrap"><div class="progress checklist-progress"><span data-checklist-progress-bar style="width:${itemProgress(item || { status })}%"></span></div><span class="help" data-checklist-count>${itemChecklist(item).length ? `${itemChecklist(item).filter(entry => entry.done).length} of ${itemChecklist(item).length} complete` : 'No checklist items yet'}</span></div>
              <div class="task-checklist" id="item-checklist">${itemChecklist(item).map(checklistRow).join('')}</div>
              <button class="btn small checklist-add" type="button" data-action="add-checklist-item">＋ Add checklist item</button>
              <span class="help">Progress is calculated automatically from the boxes you tick.</span>
            </div>
            <div class="field span-2"><label>Description / notes</label><textarea class="textarea" name="description" placeholder="Add details, links, acceptance notes…">${esc(item?.description || '')}</textarea></div>
          </div></div>
          <div class="modal-actions">
            ${item && canDeleteItems() ? `<button class="btn danger" type="button" data-action="delete-item" data-id="${item.id}" style="margin-right:auto">Delete</button>` : ''}
            <button class="btn" type="button" data-action="close-modal">Cancel</button>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>
      </div>`);
  }

  function openTrackerModal(tracker = null) {
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
    const checklist = readChecklist(form);
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
      checklist,
      progress: checklistProgress(checklist, status),
      description: fd.get('description').trim() || null
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
    const payload = {
      name: fd.get('name').trim(),
      icon: fd.get('icon').trim() || '📋',
      description: fd.get('description').trim() || null,
      kind: fd.get('kind')
    };
    let res;
    if (id) res = await state.db.from('trackers').update(payload).eq('id', id);
    else {
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
    if (['home', 'team', 'activity'].includes(state.route)) {
      const page = document.getElementById('page');
      if (page) renderPage();
    }
  }

  async function updatePresence() {
    if (!state.realtime || !state.user || !state.workspace || document.visibilityState === 'hidden') return;
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
        if (!canEditItems()) return;
        const item = state.items.find(i => i.id === el.dataset.id);
        if (item) openItemModal(item);
      } else if (action === 'add-checklist-item') {
        const form = document.getElementById('item-form');
        const list = document.getElementById('item-checklist');
        if (!form || !list) return;
        list.insertAdjacentHTML('beforeend', checklistRow());
        const row = list.lastElementChild;
        row?.querySelector('[data-checklist-text]')?.focus();
        updateChecklistPreview(form);
      } else if (action === 'remove-checklist-item') {
        const form = document.getElementById('item-form');
        el.closest('[data-checklist-row]')?.remove();
        updateChecklistPreview(form);
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

  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-checklist-text]')) {
      updateChecklistPreview(e.target.closest('#item-form'));
    }
  });

  document.addEventListener('change', async (e) => {
    try {
      if (e.target.matches('[data-inline-status]')) {
        const id = e.target.dataset.inlineStatus;
        const status = e.target.value;
        const payload = { status };
        const { error } = await state.db.from('items').update(payload).eq('id', id);
        if (error) throw error;
        const item = state.items.find(i => i.id === id);
        if (item) Object.assign(item, payload);
      }

      if (e.target.matches('[data-checklist-done]') || (e.target.matches('#item-form [name="status"]'))) {
        updateChecklistPreview(e.target.closest('#item-form'));
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

  window.addEventListener('focus', () => syncReminderTasks().catch(console.error));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncReminderTasks().catch(console.error);
      updatePresence().catch(() => {});
    } else {
      state.realtime?.untrack?.().catch?.(() => {});
    }
  });

  init();
})();
