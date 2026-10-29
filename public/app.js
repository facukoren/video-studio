'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    status: null, settings: null, jobs: [], jobsLoaded: false, csrfToken: null,
    refreshing: null, submitting: false, saving: false, retrying: false,
    activeJobId: null, activeJob: null, previewJobId: null, budgetDirty: false, pending: null,
    googleSetup: null, higgsfieldSetup: null, setupRefreshing: null,
    uploadingGoogle: false, startingHiggsfield: false, completingHiggsfield: false,
    higgsfieldAwaitingResult: false, sourceMode: 'drive', filePending: null,
  };
  const pendingStorageKey = 'kavion.video.pending.v1';
  const uploadStorageKey = 'kavion.video.upload.v1';
  const statusLabels = {
    queued: 'En cola', running: 'En edición', needs_configuration: 'Falta configurar',
    needs_attention: 'Requiere revisión', failed: 'Edición interrumpida', completed: 'Listo',
  };
  const stages = [
    ['download', 'Descarga'], ['transcribe', 'Transcripción'], ['plan', 'Dirección editorial'],
    ['cut', 'Cortes'], ['story', 'Plan visual'], ['broll', 'B-roll'], ['render', 'Montaje'],
    ['verify', 'Revisión'], ['upload', 'Guardado'],
  ];
  const stageLabels = { queued: 'Esperando su turno', completed: 'Guardado en Drive', ...Object.fromEntries(stages) };
  const icons = {
    video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  };
  const jobElements = new Map();
  const integrationElements = new Map();
  const dialogFocus = new WeakMap();
  let detailRequest = 0;
  let setupRevision = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name, className) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    if (className) node.setAttribute('class', className);
    // Only static, locally defined icon paths are inserted as markup.
    node.innerHTML = icons[name] || '';
    return node;
  }
  function setText(id, value) {
    const node = typeof id === 'string' ? $(id) : id;
    const next = String(value ?? '');
    if (node.textContent !== next) node.textContent = next;
  }
  function show(id, visible) { $(id).hidden = !visible; }
  function announce(message) { setText('live-announcement', message); }
  function safeUrl(value, { driveOnly = false, sameOrigin = false } = {}) {
    if (!value || typeof value !== 'string') return null;
    try {
      const url = new URL(value, window.location.origin);
      if (sameOrigin && url.origin === window.location.origin) return url.href;
      if (url.protocol !== 'https:') return null;
      if (driveOnly && url.hostname !== 'drive.google.com') return null;
      return url.href;
    } catch { return null; }
  }
  function safeHiggsfieldUrl(value) {
    const safe = safeUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    if (url.username || url.password || (url.port && url.port !== '443')) return null;
    return url.hostname === 'higgsfield.ai' || url.hostname.endsWith('.higgsfield.ai') ? url.href : null;
  }
  function formatDate(value, timeOnly = false) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-AR', timeOnly
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function jobName(job) { return job.sourceName || 'Video de Drive'; }
  function messageOf(error) {
    return error?.message || 'No pudimos completar la solicitud. Volvé a intentarlo.';
  }
  function jobError(job) {
    if (typeof job.error === 'string') return job.error;
    return job.error?.message || '';
  }
  function savePending(value) {
    state.pending = value;
    try {
      if (value) sessionStorage.setItem(pendingStorageKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingStorageKey);
    } catch { /* Submission still retains its key in memory if storage is unavailable. */ }
  }
  function createKey() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
    }
    return `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  class RequestError extends Error {
    constructor(message, { ambiguous = false, status = 0, code = '' } = {}) {
      super(message);
      this.ambiguous = ambiguous;
      this.status = status; this.code = code;
    }
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    }
    try {
      const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      let data;
      try { data = await response.json(); }
      catch { throw new RequestError('El servidor devolvió una respuesta que no pudimos interpretar.', { ambiguous: true, status: response.status }); }
      if (!response.ok) {
        throw new RequestError(data?.error?.message || `El servidor no pudo completar la solicitud (${response.status}).`, {
          ambiguous: response.status >= 500 || response.status === 408,
          status: response.status,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error.name === 'AbortError'
        ? 'El servidor tardó demasiado en responder. Volvé a intentarlo.'
        : 'No hay conexión con el servidor. Revisá la conexión y volvé a intentar.', { ambiguous: true });
    } finally { clearTimeout(timer); }
  }

  function refreshControls() {
    $('submit-video').disabled = state.submitting || !state.csrfToken;
    $('source-url').readOnly = state.submitting;
    for (const id of ['source-file','source-mode-drive','source-mode-upload']) $(id).disabled = state.submitting;
    $('save-settings').disabled = state.saving || !state.settings || !state.csrfToken;
    $('max-credits').readOnly = state.saving;
    $('retry-job').disabled = state.retrying || !state.csrfToken;
    $('upload-google-client').disabled = state.uploadingGoogle || !state.csrfToken || !$('google-client-file').files.length;
    $('google-client-file').disabled = state.uploadingGoogle;
    $('start-higgsfield').disabled = state.startingHiggsfield || state.completingHiggsfield || !state.csrfToken;
    $('complete-higgsfield').disabled = state.completingHiggsfield || !state.csrfToken || !$('higgsfield-callback-url').value.trim();
    $('higgsfield-callback-url').readOnly = state.completingHiggsfield;
  }
  function updateDestination() {
    const destination = state.status?.destination;
    if (!destination) return;
    const url = safeUrl(destination.url, { driveOnly: true });
    for (const id of ['destination-link', 'settings-destination-link']) {
      const link = $(id);
      if (url) { link.href = url; link.removeAttribute('aria-disabled'); } else { link.removeAttribute('href'); link.setAttribute('aria-disabled','true'); }
      if (destination.name) {
        const text = link.firstChild;
        if (text?.nodeType === Node.TEXT_NODE) text.textContent = destination.name;
      }
    }
  }
  function renderStatus() {
    const status = state.status;
    if (!status) return;
    const budgetReady = state.settings?.maxCreditsPerVideo !== null && state.settings?.maxCreditsPerVideo !== undefined;
    const ready = Boolean(status.ready && budgetReady);
    $('connection-label').dataset.state = ready ? 'ready' : 'missing';
    setText('connection-text', ready ? 'Listo para editar' : 'Configuración pendiente');
    show('setup-notice', !ready);
    const missing = (status.integrations || []).filter((entry) => entry.state !== 'ready');
    let setupText = 'Conectá los servicios y definí un límite de créditos antes de procesar videos.';
    if (budgetReady && missing.length) setupText = 'Revisá las conexiones pendientes para empezar a procesar tus videos.';
    else if (!budgetReady && !missing.length) setupText = 'Definí un límite de créditos por video para habilitar la generación de B-roll.';
    else if (budgetReady && !missing.length && !status.worker?.online) setupText = 'El motor de edición está desconectado. Los videos quedan guardados en la cola.';
    setText('setup-notice-text', setupText);
    setText('worker-status', status.worker?.online ? 'Motor de edición conectado' : 'Motor de edición desconectado');
    $('worker-dot').dataset.state = status.worker?.online ? 'ready' : 'missing';
    renderIntegrations(status.integrations || []);
    renderGoogleSetup();
    renderHiggsfieldSetup();
    updateDestination();
    refreshControls();
  }
  function renderIntegrations(integrations) {
    show('integrations-loading', !integrations.length);
    if (!integrations.length) setText('integrations-loading', 'El servidor no informó conexiones. Actualizá para volver a consultar.');
    const present = new Set();
    for (const integration of integrations) {
      if (!integration || typeof integration.id !== 'string') continue;
      present.add(integration.id);
      let view = integrationElements.get(integration.id);
      if (!view) {
        const row = element('li', 'integration-row');
        const copy = element('div');
        const name = element('p', 'integration-name');
        const detail = element('p', 'integration-detail');
        const actions = element('div', 'integration-actions');
        const badge = element('span', 'badge');
        const link = element('a', 'button button-secondary', 'Conectar');
        copy.append(name, detail); actions.append(badge, link); row.append(copy, actions);
        $('integration-list').append(row);
        view = { row, name, detail, badge, link };
        integrationElements.set(integration.id, view);
      }
      setText(view.name, integration.name || integration.id);
      setText(view.detail, integration.detail || '');
      view.detail.hidden = !integration.detail;
      const integrationState = integration.state || 'missing';
      view.badge.dataset.state = integrationState;
      setText(view.badge, { ready: 'Conectado', missing: 'Pendiente', waiting: 'En espera', error: 'Revisar' }[integrationState] || 'Pendiente');
      const action = safeUrl(integration.actionUrl, { sameOrigin: true });
      view.link.hidden = !action;
      if (action) {
        view.link.href = action;
        setText(view.link, integrationState === 'ready' ? 'Administrar' : 'Conectar');
        view.link.setAttribute('aria-label', `${integrationState === 'ready' ? 'Administrar' : 'Conectar'} ${integration.name || integration.id}`);
      }
    }
    for (const [id, view] of integrationElements) {
      if (!present.has(id)) { view.row.remove(); integrationElements.delete(id); }
    }
  }
  function renderSettings({ forceInput = false } = {}) {
    if (!state.settings) return;
    show('settings-load-error', false);
    const settings = state.settings;
    if (forceInput || (!$('settings-dialog').open && !state.budgetDirty)) {
      $('max-credits').value = settings.maxCreditsPerVideo ?? '';
    }
    setText('max-brolls', settings.maxBrolls ?? 2);
    const prompt = typeof settings.recipe === 'string' ? settings.recipe : settings.recipe?.prompt;
    if (prompt) setText('recipe-prompt', prompt);
    refreshControls();
  }

  function integrationReady(id) {
    return state.status?.integrations?.some((entry) => entry.id === id && entry.state === 'ready');
  }
  function renderGoogleSetup() {
    const setup = state.googleSetup;
    if (!setup) return;
    const ready = integrationReady('drive');
    setText('google-setup-status', ready
      ? 'Google Drive conectado.'
      : setup.configured ? 'Cliente cargado. Falta autorizar tu cuenta de Google.' : 'Prepará el cliente de Google una sola vez.');
    show('google-client-guide', !setup.configured);
    show('authorize-google', Boolean(setup.configured));
    setText('authorize-google', ready ? 'Volver a autorizar Drive' : 'Autorizar acceso a Drive');
    $('google-redirect-uri').value = typeof setup.redirectUri === 'string' ? setup.redirectUri : '';
    $('copy-google-redirect').disabled = !$('google-redirect-uri').value;
    refreshControls();
  }
  function renderHiggsfieldSetup() {
    const setup = state.higgsfieldSetup;
    if (!setup) return;
    const waiting = setup.status === 'waiting';
    const current = state.status?.integrations?.find((entry) => entry.id === 'higgsfield');
    // Setup records the OAuth attempt; only the current integration check proves connectivity.
    const connected = !waiting && current?.state === 'ready';
    if (!waiting) state.higgsfieldAwaitingResult = false;
    setText('higgsfield-setup-status', connected ? 'Higgsfield conectado.'
      : waiting ? (state.higgsfieldAwaitingResult ? (setup.message || 'Validando la autorización…') : 'Completá la autorización en tu navegador.')
        : setup.status === 'error' || current?.state === 'error' ? 'La conexión necesita revisión.'
          : setup.status === 'connected' ? 'Autorización completada. Falta verificar la conexión.' : 'Usá tu cuenta de Higgsfield con créditos.');
    show('start-higgsfield', !connected && !waiting);
    show('higgsfield-waiting', waiting && !state.higgsfieldAwaitingResult);
    const authUrl = waiting ? safeHiggsfieldUrl(setup.authUrl) : null;
    show('higgsfield-auth-link', Boolean(authUrl));
    if (authUrl) $('higgsfield-auth-link').href = authUrl;
    else $('higgsfield-auth-link').removeAttribute('href');
    const expires = waiting ? formatDate(setup.expiresAt, true) : '';
    show('higgsfield-expires', Boolean(expires));
    setText('higgsfield-expires', expires ? `Esta autorización vence a las ${expires}.` : '');
    if (waiting && !authUrl && !state.higgsfieldAwaitingResult) {
      setText('higgsfield-setup-error', 'No recibimos una dirección válida de Higgsfield. Actualizá las conexiones.');
      show('higgsfield-setup-error', true);
    } else if (setup.status === 'error' && setup.message) {
      setText('higgsfield-setup-error', setup.message);
      show('higgsfield-setup-error', true);
    }
    if (connected) {
      $('higgsfield-callback-url').value = '';
      show('higgsfield-setup-error', false);
    } else if (!waiting) show('higgsfield-setup-success', false);
    refreshControls();
  }
  function showHiggsfieldAuthorizationSuccess() {
    setText('higgsfield-setup-success', 'Autorización completada. Estamos actualizando el estado de la conexión.');
    show('higgsfield-setup-success', true);
  }
  async function refreshSetup({ higgsfieldOnly = false } = {}) {
    if (state.setupRefreshing) return state.setupRefreshing;
    const revision = setupRevision;
    state.setupRefreshing = (async () => {
      const requests = higgsfieldOnly ? [request('/api/setup/higgsfield')]
        : [request('/api/setup/higgsfield'), request('/api/setup/google')];
      const [higgsfieldResult, googleResult] = await Promise.allSettled(requests);
      if (revision !== setupRevision) return;
      if (higgsfieldResult.status === 'fulfilled') {
        const completedAuthorization = state.higgsfieldSetup?.status === 'waiting' && higgsfieldResult.value?.status === 'connected';
        state.higgsfieldSetup = higgsfieldResult.value;
        renderHiggsfieldSetup();
        if (completedAuthorization) showHiggsfieldAuthorizationSuccess();
      } else {
        setText('higgsfield-setup-error', messageOf(higgsfieldResult.reason));
        show('higgsfield-setup-error', true);
      }
      if (googleResult?.status === 'fulfilled') {
        state.googleSetup = googleResult.value;
        renderGoogleSetup();
      } else if (googleResult) {
        setText('google-setup-error', messageOf(googleResult.reason));
        show('google-setup-error', true);
      }
    })().finally(() => { state.setupRefreshing = null; });
    return state.setupRefreshing;
  }

  function renderJobs() {
    const jobs = state.jobs;
    show('history-loading', false);
    show('history-error', false);
    show('history-empty', jobs.length === 0);
    show('job-list', jobs.length > 0);
    show('job-count', jobs.length > 0);
    setText('job-count', jobs.length);
    const present = new Set();
    jobs.forEach((job, index) => {
      if (!job?.id) return;
      present.add(job.id);
      let view = jobElements.get(job.id);
      if (!view) {
        const row = element('li', 'job-row');
        const button = element('button', 'job-button'); button.type = 'button';
        const fileIcon = element('span', 'job-icon'); fileIcon.append(icon('video'));
        const copy = element('span', 'job-copy');
        const name = element('span', 'job-name');
        const meta = element('span', 'job-meta');
        const date = element('span');
        const separator = element('span', '', '·'); separator.setAttribute('aria-hidden', 'true');
        const stage = element('span');
        const badge = element('span', 'badge');
        meta.append(date, separator, stage); copy.append(name, meta);
        button.append(fileIcon, copy, badge, icon('chevron', 'job-chevron'));
        button.addEventListener('click', () => openJob(job.id));
        row.append(button);
        view = { row, button, name, date, stage, badge };
        jobElements.set(job.id, view);
      }
      setText(view.name, jobName(job));
      setText(view.date, formatDate(job.createdAt));
      setText(view.stage, stageLabels[job.stage] || 'Preparando edición');
      view.badge.dataset.state = job.status;
      setText(view.badge, statusLabels[job.status] || 'Consultando estado');
      view.button.setAttribute('aria-label', `${jobName(job)}, ${statusLabels[job.status] || 'Consultar estado'}. Ver detalle`);
      const atPosition = $('job-list').children[index];
      if (atPosition !== view.row) $('job-list').insertBefore(view.row, atPosition || null);
    });
    for (const [id, view] of jobElements) {
      if (!present.has(id)) { view.row.remove(); jobElements.delete(id); }
    }
  }

  const stageElements = stages.map(([id, label], index) => {
    const row = element('li', 'stage-item');
    const marker = element('span', 'stage-marker', index + 1); marker.setAttribute('aria-hidden', 'true');
    const name = element('span', '', label);
    row.append(marker, name); $('stage-list').append(row);
    return { id, label, row, marker, name };
  });
  function resetPreview() {
    const video = $('result-video');
    state.previewJobId = null;
    video.pause();
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
    show('result-video', false);
    show('preview-unavailable', false);
  }
  function renderPreview(job) {
    if (job.status !== 'completed') {
      if (state.previewJobId) resetPreview();
      return;
    }
    // Retain playback position and failed-preview state across polling updates.
    if (state.previewJobId === job.id) return;
    resetPreview();
    state.previewJobId = job.id;
    const video = $('result-video');
    video.setAttribute('aria-label', `Vista previa: ${jobName(job)}`);
    video.src = `/api/jobs/${encodeURIComponent(job.id)}/media`;
    show('result-video', true);
    video.load();
  }
  $('result-video').addEventListener('error', () => {
    if (!state.previewJobId || state.previewJobId !== state.activeJobId || !$('result-video').hasAttribute('src')) return;
    $('result-video').pause();
    show('result-video', false);
    show('preview-unavailable', true);
  });

  function renderDetail(job) {
    if (!job || job.id !== state.activeJobId) return;
    const previous = state.activeJob;
    state.activeJob = job;
    if (previous?.status !== job.status && previous) announce(`${jobName(job)}: ${statusLabels[job.status] || job.status}.`);
    setText('job-subtitle', jobName(job));
    $('detail-status').dataset.state = job.status;
    setText('detail-status', statusLabels[job.status] || 'Consultando estado');
    setText('detail-date', formatDate(job.createdAt));
    const sourceUrl = safeUrl(job.sourceUrl, { driveOnly: true });
    show('detail-source', Boolean(sourceUrl));
    if (sourceUrl) $('detail-source').href = sourceUrl;
    const issue = jobError(job);
    const blocked = ['needs_configuration', 'needs_attention', 'failed'].includes(job.status);
    show('detail-error', blocked || Boolean(issue));
    $('detail-error').className = `notice ${job.status === 'failed' ? 'notice-error' : 'notice-warning'}`;
    setText('detail-error-title', { needs_configuration: 'La edición está esperando configuración', needs_attention: 'Este trabajo necesita revisión', failed: 'No se pudo completar la edición' }[job.status] || 'Información del trabajo');
    const fallback = job.status === 'needs_attention'
      ? 'Revisá la operación pendiente antes de continuar. Consultá la actividad del trabajo.'
      : job.status === 'needs_configuration'
        ? 'Revisá las conexiones y el límite de créditos. Después podés reanudar este trabajo.'
        : 'Consultá la actividad y volvé a intentar.';
    setText('detail-error-message', issue || fallback);
    const resultUrl = safeUrl(job.result?.url, { driveOnly: true });
    show('detail-result', job.status === 'completed');
    show('result-link', Boolean(resultUrl));
    renderPreview(job);
    if (resultUrl) $('result-link').href = resultUrl;
    setText('result-filename', job.result?.filename || 'MP4 guardado en la carpeta de salida.');
    const currentIndex = job.status === 'completed' ? stages.length : stages.findIndex(([stage]) => stage === job.stage);
    stageElements.forEach((view, index) => {
      const label=view.id==='download'&&job.sourceType==='upload'?'Carga':view.label;setText(view.name,label);
      const progress = index < currentIndex ? 'done' : index === currentIndex ? (blocked ? 'blocked' : 'active') : 'waiting';
      view.row.dataset.state = progress;
      if (index === currentIndex) view.row.setAttribute('aria-current', 'step'); else view.row.removeAttribute('aria-current');
      const description = progress === 'done' ? 'Completada' : progress === 'active' ? 'En curso' : progress === 'blocked' ? 'Pendiente de resolver' : 'Pendiente';
      view.row.setAttribute('aria-label', `${label}: ${description}`);
      if (view.marker.dataset.state !== progress) {
        view.marker.dataset.state = progress;
        if (progress === 'done') view.marker.replaceChildren(icon('check'));
        else view.marker.textContent = String(index + 1);
      }
    });
    const events = Array.isArray(job.events) ? job.events : [];
    show('event-section', events.length > 0);
    const eventSignature = JSON.stringify(events);
    if ($('event-list').dataset.signature !== eventSignature) {
      const fragment = document.createDocumentFragment();
      events.forEach((event) => {
        const row = element('li', 'event-item');
        const dateValue = event.at || event.createdAt || event.timestamp;
        const time = element('time', '', formatDate(dateValue, true));
        if (dateValue) time.setAttribute('datetime', dateValue);
        row.append(time, element('p', '', event.message || stageLabels[event.stage] || 'Estado actualizado'));
        fragment.append(row);
      });
      $('event-list').replaceChildren(fragment);
      $('event-list').dataset.signature = eventSignature;
    }
    show('detail-configure', job.status === 'needs_configuration' || job.status === 'needs_attention');
    show('retry-job', ['failed', 'needs_configuration', 'needs_attention'].includes(job.status));
    const retryLabel = { needs_attention: 'Volver a revisar', needs_configuration: 'Reanudar edición', failed: 'Reintentar edición' };
    setText('retry-job', state.retrying ? 'Reanudando…' : retryLabel[job.status] || 'Reintentar edición');
    refreshControls();
  }

  function openDialog(id) {
    const dialog = $(id);
    const trigger = document.activeElement;
    const closedDialog = trigger?.closest?.('dialog:not([open])');
    dialogFocus.set(dialog, closedDialog ? $('settings-open') : trigger);
    if (!dialog.open) dialog.showModal();
  }
  function openSettings() {
    state.budgetDirty = false;
    show('settings-error', false); show('settings-success', false);
    $('max-credits').removeAttribute('aria-invalid');
    renderSettings({ forceInput: true });
    show('settings-load-error', !state.settings);
    openDialog('settings-dialog');
    if (!state.settings || !state.status) refresh();
    refreshSetup();
  }
  async function loadDetail(id) {
    const sequence = ++detailRequest;
    try {
      const job = await request(`/api/jobs/${encodeURIComponent(id)}`);
      if (sequence !== detailRequest || state.activeJobId !== id) return;
      show('detail-fetch-error', false);
      renderDetail(job);
    } catch (error) {
      if (sequence !== detailRequest || state.activeJobId !== id) return;
      setText('detail-fetch-error', `${messageOf(error)} La última información recibida sigue visible.`);
      show('detail-fetch-error', true);
    }
  }
  function openJob(id) {
    resetPreview();
    state.activeJobId = id; state.activeJob = null;
    show('retry-error', false); show('detail-fetch-error', false);
    const job = state.jobs.find((item) => item.id === id);
    if (job) renderDetail(job);
    openDialog('job-dialog');
    loadDetail(id);
  }

  async function refresh({ manual = false } = {}) {
    if (state.refreshing) return state.refreshing;
    $('refresh-jobs').disabled = true;
    $('refresh-connections').disabled = true;
    $('reconnect').disabled = true;
    state.refreshing = (async () => {
      const results = await Promise.allSettled([request('/api/status'), request('/api/settings'), request('/api/jobs')]);
      const [statusResult, settingsResult, jobsResult] = results;
      if (statusResult.status === 'fulfilled' && statusResult.value && typeof statusResult.value === 'object') {
        state.status = statusResult.value;
        state.csrfToken = typeof state.status.csrfToken === 'string' ? state.status.csrfToken : null;
        show('api-alert', false);
      } else {
        state.csrfToken = null;
        show('api-alert', true);
        setText('api-error-text', messageOf(statusResult.reason));
        setText('connection-text', 'Sin conexión');
        $('connection-label').dataset.state = 'error';
      }
      if (settingsResult.status === 'fulfilled' && settingsResult.value && typeof settingsResult.value === 'object') {
        state.settings = settingsResult.value;
        renderSettings();
      } else if (!state.settings) show('settings-load-error', true);
      if (statusResult.status === 'fulfilled') renderStatus();
      if (jobsResult.status === 'fulfilled') {
        const jobs = Array.isArray(jobsResult.value) ? jobsResult.value : jobsResult.value?.jobs;
        if (Array.isArray(jobs)) {
          state.jobs = jobs;
          state.jobsLoaded = true;
          renderJobs();
          show('history-update-error', false);
          if (manual) announce('Historial actualizado.');
        } else showHistoryError(new Error('El servidor no devolvió un historial válido.'));
      } else showHistoryError(jobsResult.reason);
      refreshControls();
      if ($('job-dialog').open && state.activeJobId) await loadDetail(state.activeJobId);
    })().finally(() => {
      state.refreshing = null;
      $('refresh-jobs').disabled = false;
      $('refresh-connections').disabled = false;
      $('reconnect').disabled = false;
    });
    return state.refreshing;
  }
  function showHistoryError(error) {
    show('history-loading', false);
    if (state.jobsLoaded) show('history-update-error', true);
    else {
      show('history-error', true); show('history-empty', false);
      setText('history-error-text', messageOf(error));
    }
  }
  function validateSource(value) {
    let url;
    try { url = new URL(value); } catch { return 'Pegá un enlace válido de un archivo de Google Drive.'; }
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) {
      return 'Usá un enlace seguro de drive.google.com.';
    }
    if (url.pathname.includes('/folders/')) return 'Ese enlace es de una carpeta. Pegá el enlace del archivo de video.';
    const filePath = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
    const queryId = ['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null;
    if (!filePath && (!queryId || !/^[A-Za-z0-9_-]+$/.test(queryId))) {
      return 'No encontramos un archivo en ese enlace. En Drive, abrí el video y copiá su enlace.';
    }
    return null;
  }

  function setSourceMode(mode) {
    if(state.submitting)return;
    state.sourceMode=mode;
    const upload=mode==='upload';
    show('drive-source',!upload);show('file-source',upload);
    $('source-mode-drive').setAttribute('aria-pressed',String(!upload));
    $('source-mode-upload').setAttribute('aria-pressed',String(upload));
    $('source-label').htmlFor=upload?'source-file':'source-url';
    setText('source-label',upload?'Video de tu dispositivo':'Enlace del video en Drive');
    setText('source-hint',upload?'MOV, MP4, M4V, MKV, WebM, AVI, MPG, MPEG, MTS o M2TS. Hasta 2 GB y 10 minutos.':'Usá el enlace de un archivo de video. El original se conserva.');
    setText('submit-label',upload?'Subir y editar':'Editar video');
    show('source-error',false);show('submission-message',false);
  }
  function saveFilePending(value){
    state.filePending=value;
    try{if(value)sessionStorage.setItem(uploadStorageKey,JSON.stringify(value));else sessionStorage.removeItem(uploadStorageKey);}catch{}
  }
  function validateFile(file){
    if(!file)return 'Seleccioná el video que querés editar.';
    if(!/\.(mov|mp4|m4v|mkv|webm|avi|mpg|mpeg|mts|m2ts)$/i.test(file.name))return 'Elegí un video MOV, MP4, M4V, MKV, WebM, AVI, MPG, MPEG, MTS o M2TS.';
    if(file.size===0)return 'El archivo está vacío.';
    if(file.size>2*1024**3)return 'El archivo supera el límite de 2 GB.';
    return null;
  }
  function uploadFile(file,key){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST','/api/jobs/upload');xhr.timeout=41*60*1000;
      xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',state.csrfToken);
      xhr.setRequestHeader('Idempotency-Key',key);xhr.setRequestHeader('X-Video-Filename',encodeURIComponent(file.name));
      xhr.upload.onprogress=event=>{
        if(!event.lengthComputable)return;
        const percent=Math.min(100,Math.round(event.loaded/event.total*100));$('upload-meter').value=percent;
        setText('upload-progress-text',percent===100?'Carga completa. Validando el video…':`Subiendo video: ${percent} %. Mantené esta página abierta.`);
      };
      xhr.onload=()=>{
        let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new RequestError('No pudimos confirmar la carga.',{ambiguous:true}));return;}
        if(xhr.status<200||xhr.status>=300){reject(new RequestError(result?.error?.message||'No se pudo subir el video.',{status:xhr.status,code:result?.error?.code,ambiguous:xhr.status>=500||xhr.status===408}));return;}
        resolve(result);
      };
      xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(new RequestError('Se interrumpió la conexión durante la carga.',{ambiguous:true}));
      xhr.send(file);
    });
  }
  $('source-mode-drive').addEventListener('click',()=>setSourceMode('drive'));
  $('source-mode-upload').addEventListener('click',()=>setSourceMode('upload'));
  $('source-file').addEventListener('change',()=>{
    const file=$('source-file').files[0];show('selected-file',Boolean(file));
    if(file)setText('selected-file',`${file.name} · ${(file.size/1024**2).toLocaleString('es-AR',{maximumFractionDigits:1})} MB`);
    $('source-file').removeAttribute('aria-invalid');show('source-error',false);show('submission-message',false);
  });
  window.addEventListener('beforeunload',event=>{if(state.submitting&&state.sourceMode==='upload'){event.preventDefault();event.returnValue='';}});

  $('video-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.submitting) return;
    const sourceUrl = $('source-url').value.trim();
    const isUpload=state.sourceMode==='upload',file=$('source-file').files[0];
    const input=$(isUpload?'source-file':'source-url');
    const invalid = isUpload?validateFile(file):validateSource(sourceUrl);
    show('submission-message', false);
    if (invalid) {
      setText('source-error', invalid); show('source-error', true);
      input.setAttribute('aria-invalid', 'true'); input.focus(); return;
    }
    if (!state.csrfToken) { setText('source-error', 'Reconectá con el servidor antes de enviar el video.'); show('source-error', true); return; }
    input.removeAttribute('aria-invalid'); show('source-error', false);
    let pending;
    if(isUpload){
      const signature=JSON.stringify([file.name,file.size,file.lastModified]);
      if(!state.filePending||state.filePending.signature!==signature)saveFilePending({signature,key:createKey()});
      pending=state.filePending;$('upload-meter').value=0;setText('upload-progress-text','Preparando la carga…');show('upload-progress',true);
    }else{
      if (!state.pending || state.pending.sourceUrl !== sourceUrl) savePending({ sourceUrl, key: createKey() });
      pending=state.pending;
    }
    state.submitting = true; refreshControls();
    setText('submit-label', 'Enviando…'); show('submit-icon', false); show('submit-spinner', true);
    try {
      const job = isUpload?await uploadFile(file,pending.key):await request('/api/jobs', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify({ sourceUrl }) });
      if (!job?.id || typeof job.id !== 'string') throw new RequestError('No pudimos confirmar la creación del trabajo.', { ambiguous: true });
      if(isUpload){saveFilePending(null);$('source-file').value='';show('selected-file',false);}else{savePending(null);$('source-url').value='';}
      const existing = state.jobs.findIndex((item) => item.id === job.id);
      if (existing >= 0) state.jobs[existing] = job; else state.jobs.unshift(job);
      state.jobsLoaded = true; renderJobs();
      setText('submission-message', 'Video agregado. Podés seguir su edición en Tus videos.');
      show('submission-message', true);
      announce('Video agregado a la cola de edición.');
      refresh();
    } catch (error) {
      if(isUpload){if(!error.ambiguous&&![409,429].includes(error.status)||error.code==='idempotency_conflict')saveFilePending(null);}else if(!error.ambiguous)savePending(null);
      const message = error.ambiguous
        ? `${messageOf(error)} ${isUpload?'Volvé a subir el mismo archivo; comprobaremos el intento anterior para evitar duplicados.':'Si volvés a enviar este enlace, comprobaremos el mismo intento para evitar duplicados.'}`
        : messageOf(error);
      setText('source-error', message); show('source-error', true);
      if (error.status === 403 || error.status === 401) refresh();
    } finally {
      state.submitting = false; refreshControls();
      setText('submit-label',state.sourceMode==='upload'?'Subir y editar':'Editar video');show('upload-progress',false);show('submit-icon',true);show('submit-spinner',false);
    }
  });
  $('source-url').addEventListener('input', () => {
    if (state.pending && state.pending.sourceUrl !== $('source-url').value.trim()) savePending(null);
    $('source-url').removeAttribute('aria-invalid');
    show('source-error', false); show('submission-message', false);
  });

  $('copy-google-redirect').addEventListener('click', async () => {
    const field = $('google-redirect-uri');
    if (!field.value) return;
    try {
      await navigator.clipboard.writeText(field.value);
      setText('google-copy-status', 'Dirección copiada. Pegala en los URI de redireccionamiento autorizados.');
    } catch {
      field.focus(); field.select();
      setText('google-copy-status', 'La dirección quedó seleccionada. Copiala y pegala en Google Cloud.');
    }
    show('google-copy-status', true);
  });
  $('google-client-file').addEventListener('change', () => {
    show('google-setup-error', false); show('google-setup-success', false); refreshControls();
  });
  $('google-client-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.uploadingGoogle || !state.csrfToken) return;
    const file = $('google-client-file').files[0];
    if (!file) return;
    show('google-setup-error', false); show('google-setup-success', false);
    state.uploadingGoogle = true; refreshControls(); setText('upload-google-client', 'Cargando…');
    ++setupRevision;
    try {
      if (file.size > 65536) throw new Error('Ese archivo es demasiado grande. Usá el JSON del cliente OAuth que descargaste de Google Cloud.');
      let client;
      try { client = JSON.parse(await file.text()); }
      catch { throw new Error('No pudimos leer ese JSON. Volvé a descargar el cliente desde Google Cloud.'); }
      if (!client || typeof client !== 'object' || !client.web?.client_id || !client.web?.client_secret) {
        throw new Error('Elegí el JSON de un cliente OAuth de tipo Aplicación web.');
      }
      state.googleSetup = await request('/api/setup/google', { method: 'POST', body: JSON.stringify({ client }) });
      renderGoogleSetup();
      setText('google-setup-success', 'Cliente cargado. Pulsá Autorizar acceso a Drive para conectar tu cuenta.');
      show('google-setup-success', true);
      refresh();
    } catch (error) {
      setText('google-setup-error', messageOf(error)); show('google-setup-error', true);
      if (error.status === 401 || error.status === 403) refresh();
    } finally {
      $('google-client-file').value = '';
      state.uploadingGoogle = false; refreshControls(); setText('upload-google-client', 'Cargar cliente de Google');
    }
  });
  $('start-higgsfield').addEventListener('click', async () => {
    if (state.startingHiggsfield || !state.csrfToken) return;
    state.startingHiggsfield = true; refreshControls(); setText('start-higgsfield', 'Preparando conexión…');
    ++setupRevision;
    state.higgsfieldAwaitingResult = false;
    show('higgsfield-setup-error', false); show('higgsfield-setup-success', false);
    $('higgsfield-callback-url').value = '';
    try {
      state.higgsfieldSetup = await request('/api/setup/higgsfield/start', { method: 'POST', body: '{}' });
      renderHiggsfieldSetup();
      if (state.higgsfieldSetup.status === 'waiting') $('higgsfield-auth-link').focus();
      if (state.higgsfieldSetup.status === 'connected') { showHiggsfieldAuthorizationSuccess(); refresh(); }
    } catch (error) {
      setText('higgsfield-setup-error', messageOf(error)); show('higgsfield-setup-error', true);
      if (error.status === 401 || error.status === 403) refresh();
    } finally {
      state.startingHiggsfield = false; refreshControls(); setText('start-higgsfield', 'Conectar Higgsfield');
    }
  });
  $('higgsfield-callback-url').addEventListener('input', () => {
    $('higgsfield-callback-url').removeAttribute('aria-invalid');
    show('higgsfield-setup-error', false); refreshControls();
  });
  $('higgsfield-callback-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.completingHiggsfield || !state.csrfToken) return;
    const callbackUrl = $('higgsfield-callback-url').value.trim();
    let callback;
    try { callback = new URL(callbackUrl); } catch { /* Show a plain validation message below. */ }
    if (!callback || callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname)
      || callback.port !== '8765' || callback.pathname !== '/callback' || callback.username || callback.password
      || !callback.searchParams.get('code') || !callback.searchParams.get('state')) {
      setText('higgsfield-setup-error', 'Pegá la dirección completa de localhost:8765/callback o 127.0.0.1:8765/callback que aparece después de autorizar Higgsfield.');
      show('higgsfield-setup-error', true);
      $('higgsfield-callback-url').setAttribute('aria-invalid', 'true'); $('higgsfield-callback-url').focus(); return;
    }
    state.completingHiggsfield = true;
    ++setupRevision;
    // The one-use callback is held only for this request, never in browser storage or app state.
    $('higgsfield-callback-url').value = '';
    refreshControls(); setText('complete-higgsfield', 'Completando…'); show('higgsfield-setup-error', false);
    try {
      const result = await request('/api/setup/higgsfield/complete', { method: 'POST', body: JSON.stringify({ callbackUrl }) });
      state.higgsfieldSetup = { ...state.higgsfieldSetup, ...result };
      state.higgsfieldAwaitingResult = result.status === 'waiting';
      renderHiggsfieldSetup();
      if (state.higgsfieldSetup.status === 'connected') {
        showHiggsfieldAuthorizationSuccess();
        refresh();
      }
    } catch (error) {
      setText('higgsfield-setup-error', messageOf(error)); show('higgsfield-setup-error', true);
      // Recheck whether an ambiguous response completed authorization on the server.
      refreshSetup({ higgsfieldOnly: true });
    } finally {
      $('higgsfield-callback-url').value = '';
      state.completingHiggsfield = false; refreshControls(); setText('complete-higgsfield', 'Completar conexión');
    }
  });

  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.saving || !state.csrfToken) return;
    const raw = $('max-credits').value.trim();
    const budget = Number(raw);
    show('settings-success', false);
    if (!raw || !Number.isFinite(budget) || budget < 0 || budget > 10000) {
      setText('settings-error', 'Ingresá un límite entre 0 y 10.000 créditos.'); show('settings-error', true);
      $('max-credits').setAttribute('aria-invalid', 'true'); $('max-credits').focus(); return;
    }
    show('settings-error', false); $('max-credits').removeAttribute('aria-invalid');
    state.saving = true; refreshControls(); setText('save-settings', 'Guardando…');
    try {
      const settings = await request('/api/settings', { method: 'PUT', body: JSON.stringify({ maxCreditsPerVideo: budget }) });
      state.settings = settings; state.budgetDirty = false;
      renderSettings({ forceInput: true }); renderStatus();
      setText('settings-success', 'Límite de créditos guardado.'); show('settings-success', true);
      refresh();
    } catch (error) {
      setText('settings-error', messageOf(error)); show('settings-error', true);
      if (error.status === 403 || error.status === 401) refresh();
    } finally { state.saving = false; refreshControls(); setText('save-settings', 'Guardar límite'); }
  });
  $('max-credits').addEventListener('input', () => {
    state.budgetDirty = true;
    $('max-credits').removeAttribute('aria-invalid'); show('settings-error', false); show('settings-success', false);
  });
  $('retry-job').addEventListener('click', async () => {
    const id = state.activeJobId;
    if (!id || state.retrying || !state.csrfToken) return;
    state.retrying = true; refreshControls(); setText('retry-job', 'Reanudando…'); show('retry-error', false);
    try {
      const job = await request(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' });
      if (!job?.id) throw new RequestError('No pudimos confirmar la reanudación. Actualizá el estado antes de volver a intentar.', { ambiguous: true });
      renderDetail(job);
      announce('El video volvió a la cola de edición.');
      await refresh();
    } catch (error) { setText('retry-error', messageOf(error)); show('retry-error', true); await loadDetail(id); }
    finally { state.retrying = false; refreshControls(); if (state.activeJob) renderDetail(state.activeJob); }
  });

  $('settings-open').addEventListener('click', openSettings);
  $('setup-notice-open').addEventListener('click', openSettings);
  $('detail-configure').addEventListener('click', () => { $('job-dialog').close(); openSettings(); });
  $('focus-input').addEventListener('click', () => { const input=$(state.sourceMode==='upload'?'source-file':'source-url');input.focus();input.scrollIntoView({block:'center',behavior:'auto'}); });
  for (const id of ['refresh-jobs', 'refresh-connections', 'retry-history', 'reconnect']) $(id).addEventListener('click', () => {
    refresh({ manual: true });
    if ($('settings-dialog').open) refreshSetup();
  });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      if (dialog.id === 'job-dialog') { resetPreview(); state.activeJobId = null; state.activeJob = null; ++detailRequest; }
      if (dialog.id === 'settings-dialog') $('higgsfield-callback-url').value = '';
      const trigger = dialogFocus.get(dialog);
      if (trigger instanceof HTMLElement && trigger.isConnected && !document.querySelector('dialog[open]')) trigger.focus();
    });
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingStorageKey));
    if (saved && typeof saved.sourceUrl === 'string' && typeof saved.key === 'string' && saved.key.length >= 8 && !validateSource(saved.sourceUrl)) {
      state.pending = saved; $('source-url').value = saved.sourceUrl;
      setText('source-error', 'Quedó un envío sin confirmar. Volvé a enviar este enlace para consultar el mismo intento sin duplicarlo.'); show('source-error', true);
    }
  } catch { /* No saved submission. */ }
  try{
    const saved=JSON.parse(sessionStorage.getItem(uploadStorageKey));
    if(saved&&typeof saved.signature==='string'&&saved.signature.length<1000&&typeof saved.key==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(saved.key)){
      state.filePending=saved;setSourceMode('upload');
      setText('source-error','Quedó una carga sin confirmar. Seleccioná el mismo archivo y volvé a enviarlo para recuperar el intento sin duplicarlo.');show('source-error',true);
    }
  }catch{}
  const oauthResult = new URL(window.location.href).searchParams.get('google');
  if (oauthResult) {
    const cleanUrl = new URL(window.location.href); cleanUrl.searchParams.delete('google');
    history.replaceState(null, '', cleanUrl);
    if (oauthResult === 'connected') { setText('submission-message', 'Google Drive conectado. Revisá las demás conexiones en Configuración.'); show('submission-message', true); }
    if (oauthResult === 'error') { setText('source-error', 'No se completó la conexión de Google Drive. Podés volver a intentarlo desde Configuración.'); show('source-error', true); }
  }
  refresh();
  setInterval(() => {
    if (!document.hidden) {
      refresh();
      if (state.higgsfieldSetup?.status === 'waiting' && !state.completingHiggsfield) refreshSetup({ higgsfieldOnly: true });
    }
  }, 6000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      if (state.higgsfieldSetup?.status === 'waiting') refreshSetup({ higgsfieldOnly: true });
    }
  });
})();
