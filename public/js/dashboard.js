(() => {
  const timer = document.getElementById('focus-timer');
  const toggleButton = document.getElementById('focus-toggle');
  const fullscreenButton = document.getElementById('focus-fullscreen');
  const timerValue = document.getElementById('focus-timer-value');
  const timerStatus = document.getElementById('focus-timer-status');
  const totalValue = document.querySelector('[data-total-focus-minutes]');
  const todayMinutesValue = document.getElementById('today-focus-minutes');
  const todayFocusWheel = document.getElementById('today-focus-wheel');
  const todayProgress = document.getElementById('today-focus-progress');

  if (!timer || !toggleButton || !timerValue || !timerStatus) return;

  const cacheScope = timer.dataset.userId || 'anonymous';
  const activeStorageKey = `focus-tracker.active-session.v1:${cacheScope}`;
  const queueStorageKey = `focus-tracker.pending-sessions.v1:${cacheScope}`;
  const dailyStorageKey = `focus-tracker.daily-focus.v1:${cacheScope}`;

  let activeSession = readJson(activeStorageKey);
  let pendingSessions = readJson(queueStorageKey);
  if (!Array.isArray(pendingSessions)) pendingSessions = [];
  const todayKey = new Date().toISOString().slice(0, 10);
  const storedDaily = readJson(dailyStorageKey);
  let dailyFocusSeconds = storedDaily?.date === todayKey
    ? Math.max(Number(storedDaily.seconds) || 0, Number(timer.dataset.todayFocusSeconds) || 0)
    : Number(timer.dataset.todayFocusSeconds) || 0;
  let todayManualMinutes = Number(timer.dataset.todayLogMinutes) || 0;
  let displayTotalSeconds = Number(totalValue?.dataset.totalFocusMinutes || 0) * 60;
  const dailyGoalMinutes = Number(timer.dataset.goalMinutes || 300);
  const timeUnit = timer.dataset.timeUnit === 'hours' ? 'hours' : 'minutes';
  let tickHandle = null;
  let toggleInProgress = false;

  function readJson(key) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`Unable to read ${key}`, error);
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Unable to write ${key}`, error);
      return false;
    }
  }

  function makeSessionId() {
    return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainder = safeSeconds % 60;
    return hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function setStatus(message, state = '') {
    timerStatus.textContent = message;
    timerStatus.dataset.state = state;
  }

  function renderToggle() {
    const running = Boolean(activeSession);
    toggleButton.innerHTML = running
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Zm10 0a2 2 0 0 1 2 2v10a2 2 0 1 1-4 0V7a2 2 0 0 1 2-2Z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.1-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z"/></svg>';
    toggleButton.setAttribute('aria-label', running ? 'Pause focus timer' : 'Start focus timer');
    toggleButton.title = 'Play / Pause (P)';
    toggleButton.dataset.running = running ? 'true' : 'false';
  }

  function renderTotal() {
    if (!totalValue) return;
    const minutes = displayTotalSeconds / 60;
    const value = timeUnit === 'hours' ? Math.round((minutes / 60) * 10) / 10 : Math.round(minutes);
    totalValue.textContent = `${timeUnit === 'hours' ? value.toFixed(1) : value.toFixed(0)}${timeUnit === 'hours' ? 'h' : 'm'}`;
  }

  function renderToday(minutes) {
    const roundedMinutes = Math.max(0, Math.round(Number(minutes) || 0));
    const displayValue = timeUnit === 'hours'
      ? Math.round((roundedMinutes / 60) * 10) / 10
      : roundedMinutes;
    const percentage = Math.round((roundedMinutes / dailyGoalMinutes) * 100);
    const progressDegrees = Math.min((roundedMinutes / dailyGoalMinutes) * 360, 360);
    const color = roundedMinutes >= dailyGoalMinutes
      ? '#4ade80'
      : roundedMinutes > 0 ? '#FFD700' : '#ef4444';
    const progressText = percentage >= 100
      ? `${percentage}% (Goal Met)`
      : percentage === 0 ? '0% Started' : `${percentage}% Complete`;

    if (todayMinutesValue) {
      todayMinutesValue.textContent = `${timeUnit === 'hours' ? displayValue.toFixed(1) : displayValue.toFixed(0)}${timeUnit === 'hours' ? 'h' : 'm'}`;
      todayMinutesValue.style.color = color;
    }
    if (todayFocusWheel) {
      todayFocusWheel.style.background = `conic-gradient(${color} ${progressDegrees}deg, #1c1c1c 0deg)`;
    }
    if (todayProgress) todayProgress.textContent = progressText;
  }

  function applyServerTotals(result) {
    if (Number.isFinite(Number(result.totalFocusMinutes))) {
      displayTotalSeconds = Number(result.totalFocusMinutes) * 60;
      renderTotal();
    }
    if (Number.isFinite(Number(result.todayMinutes))) renderToday(result.todayMinutes);
  }

  function renderTimer() {
    if (!activeSession) {
      timerValue.textContent = formatDuration(dailyFocusSeconds + todayManualMinutes * 60);
      renderToggle();
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - activeSession.startTime) / 1000);
    timerValue.textContent = formatDuration((dailyFocusSeconds + todayManualMinutes * 60) + elapsedSeconds);
    renderToggle();
    setStatus('Focus session running', 'running');
  }

  function startTicking() {
    if (tickHandle) clearInterval(tickHandle);
    renderTimer();
    tickHandle = setInterval(renderTimer, 250);
  }

  function enqueue(session) {
    if (!Array.isArray(pendingSessions)) pendingSessions = [];
    if (!pendingSessions.some(item => item.sessionId === session.sessionId)) {
      pendingSessions.push(session);
      writeJson(queueStorageKey, pendingSessions);
    }
  }

  async function flushPendingSessions() {
    if (!pendingSessions.length) return;
    let firstUnsyncedIndex = pendingSessions.length;

    for (let index = 0; index < pendingSessions.length; index += 1) {
      const session = pendingSessions[index];
      try {
        const response = await fetch('/api/focus-sessions', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(session)
        });
        if (!response.ok) throw new Error(`Session sync failed with ${response.status}`);
        const result = await response.json();
        applyServerTotals(result);
      } catch (error) {
        console.warn('Focus session kept locally for retry', error);
        firstUnsyncedIndex = index;
        break;
      }
    }

    pendingSessions = pendingSessions.slice(firstUnsyncedIndex);
    writeJson(queueStorageKey, pendingSessions);
    if (pendingSessions.length) setStatus('Saved locally. Waiting to sync.', 'pending');
    else if (!activeSession) setStatus('Session saved', 'saved');
  }

  function toggleTimer() {
    if (toggleInProgress) return;
    toggleInProgress = true;

    if (activeSession) {
      const endTime = Date.now();
      const completedSession = {
        sessionId: activeSession.sessionId,
        startTime: new Date(activeSession.startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationSeconds: Math.max(0, Math.round((endTime - activeSession.startTime) / 1000)),
        status: 'completed'
      };
      displayTotalSeconds += completedSession.durationSeconds;
      dailyFocusSeconds += completedSession.durationSeconds;
      writeJson(dailyStorageKey, { date: todayKey, seconds: dailyFocusSeconds });
      renderTotal();
      renderToday((dailyFocusSeconds / 60) + todayManualMinutes);
      enqueue(completedSession);
      activeSession = null;
      localStorage.removeItem(activeStorageKey);
      renderTimer();
      setStatus('Saving session...', 'saving');
      flushPendingSessions();
      toggleInProgress = false;
      return;
    }
    activeSession = { sessionId: makeSessionId(), startTime: Date.now(), status: 'active' };
    if (!writeJson(activeStorageKey, activeSession)) {
      activeSession = null;
      setStatus('Could not start timer storage', 'error');
      toggleInProgress = false;
      return;
    }
    setStatus('Focus session running', 'running');
    renderTimer();
    toggleInProgress = false;
  }

  toggleButton.addEventListener('pointerup', event => {
    if (event.button !== 0) return;
    toggleTimer();
  });

  toggleButton.addEventListener('click', event => {
    if (event.detail > 0) return;
    toggleTimer();
  });

  document.addEventListener('keydown', event => {
    const target = event.target;
    const isTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement || target.isContentEditable;
    if (isTextEntry || event.repeat || event.key.toLowerCase() !== 'p') return;
    event.preventDefault();
    toggleTimer();
  });

  fullscreenButton?.addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await timer.requestFullscreen();
  });

  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement === timer;
    if (fullscreenButton) {
      fullscreenButton.innerHTML = isFullscreen
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 9-6 6m0-6 6 6M15 9l6 6m0-6-6 6"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/></svg>';
      fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen timer' : 'Enter fullscreen timer');
      fullscreenButton.title = isFullscreen ? 'Exit fullscreen timer' : 'Enter fullscreen timer';
    }
  });

  window.focusTrackerSyncToday = ({ mode, inputMinutes, logDate }) => {
    if (logDate !== todayKey) return;
    const valueMinutes = Math.max(0, Number(inputMinutes) || 0);
    if (mode === 'reset') {
      todayManualMinutes = valueMinutes;
      dailyFocusSeconds = 0;
      if (activeSession) {
        activeSession.startTime = Date.now();
        writeJson(activeStorageKey, activeSession);
      }
    } else {
      todayManualMinutes += valueMinutes;
    }
    writeJson(dailyStorageKey, { date: todayKey, seconds: dailyFocusSeconds });
    renderTimer();
    renderToday((dailyFocusSeconds / 60) + todayManualMinutes);
  };

  window.addEventListener('storage', event => {
    if (event.key !== `focus-tracker.today-sync.v1:${cacheScope}` || !event.newValue) return;
    try {
      window.focusTrackerSyncToday(JSON.parse(event.newValue));
    } catch (error) {
      console.warn('Unable to apply cross-page focus update', error);
    }
  });

  window.addEventListener('online', flushPendingSessions);
  startTicking();
  flushPendingSessions();
})();
