(() => {
  const planner = document.getElementById('daily-planner');
  const taskList = document.getElementById('planner-task-list');
  const taskForm = document.getElementById('planner-task-form');
  const taskInput = document.getElementById('planner-task-input');
  const noteInput = document.getElementById('planner-note');
  const noteDisplay = document.getElementById('planner-note-display');
  const noteSaveButton = document.getElementById('planner-note-save');
  const editButton = document.getElementById('planner-edit');
  const saveState = document.getElementById('planner-save-state');
  const taskCount = document.getElementById('planner-task-count');
  const progressLabel = document.getElementById('planner-progress');
  const dateInput = document.getElementById('planner-date');
  const dateLabel = document.getElementById('planner-date-label');
  const datePickerButton = document.querySelector('.planner-date-picker button');
  if (!planner || !taskList || !taskForm || !noteInput || !dateInput) return;

  const makeId = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pad = value => String(value).padStart(2, '0');
  const keyForDate = value => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const dateFromKey = key => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day); };
  const todayKey = keyForDate(new Date());
  const userKey = document.getElementById('focus-timer')?.dataset.userId || 'anonymous';
  const state = { date: todayKey, tasks: [], savedNote: '', note: '', noteEditing: false, taskSaveTimer: null, dropIndex: null };
  const draftKey = suffix => `focus-tracker.planner-draft.v1:${userKey}:${state.date}:${suffix}`;
  let draggedTaskId = null;

  const setSaveState = value => { if (saveState) saveState.textContent = value; };
  const updateEditMode = () => {
    if (editButton) editButton.hidden = state.noteEditing;
    noteInput.readOnly = !state.noteEditing;
    noteInput.hidden = !state.noteEditing;
    noteInput.classList.toggle('planner-readonly', !state.noteEditing);
    if (noteDisplay) noteDisplay.hidden = state.noteEditing;
    noteSaveButton.hidden = !state.noteEditing;
  };

  const renderNote = () => {
    if (!noteDisplay) return;
    noteDisplay.textContent = state.savedNote.trim() || 'No notes were added for this day.';
    noteDisplay.classList.toggle('is-empty', !state.savedNote.trim());
  };

  function renderTasks() {
    taskList.replaceChildren();
    const completed = state.tasks.filter(task => task.completed).length;
    taskCount.textContent = `${completed} of ${state.tasks.length} tasks completed`;
    if (progressLabel) progressLabel.textContent = `${state.tasks.length ? Math.round(completed / state.tasks.length * 100) : 0}%`;
    if (!state.tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'planner-empty';
      empty.textContent = 'No tasks yet. Add the first thing you want to finish.';
      taskList.append(empty);
      return;
    }
    state.tasks.forEach((task, index) => {
      const row = document.createElement('div');
      row.className = `planner-task${task.completed ? ' completed' : ''}`;
      row.draggable = true;
      row.dataset.taskId = task.taskId;
      row.addEventListener('dragstart', event => {
        draggedTaskId = task.taskId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.taskId);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => {
        draggedTaskId = null;
        taskList.querySelector('.planner-drop-line')?.remove();
        state.dropIndex = null;
        row.classList.remove('is-dragging');
      });
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = task.completed;
      checkbox.addEventListener('change', () => {
        task.completed = checkbox.checked;
        if (checkbox.checked) {
          const completedIndex = state.tasks.indexOf(task);
          if (completedIndex >= 0) {
            state.tasks.splice(completedIndex, 1);
            state.tasks.push(task);
          }
        } else {
          const activeIndex = state.tasks.indexOf(task);
          if (activeIndex >= 0) {
            state.tasks.splice(activeIndex, 1);
            const firstCompletedIndex = state.tasks.findIndex(item => item.completed);
            if (firstCompletedIndex < 0) state.tasks.push(task);
            else state.tasks.splice(firstCompletedIndex, 0, task);
          }
        }
        markTasksChanged();
      });
      const title = document.createElement('span');
      title.textContent = task.title;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'planner-delete';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        state.tasks.splice(index, 1);
        markTasksChanged();
      });
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'planner-move';
      move.setAttribute('aria-label', 'Move task to next day');
      move.title = 'Move to next day';
      move.textContent = '→';
      move.addEventListener('click', () => moveTaskToNextDay(task));
      row.append(checkbox, title, move, remove);
      taskList.append(row);
    });
  }

  taskList.addEventListener('dragover', event => {
    if (!draggedTaskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rows = [...taskList.querySelectorAll('.planner-task:not(.is-dragging)')];
    const target = rows.findIndex(row => event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2);
    state.dropIndex = target < 0 ? state.tasks.length : state.tasks.indexOf(state.tasks.find(task => task.taskId === rows[target]?.dataset.taskId));
    if (state.dropIndex < 0) state.dropIndex = state.tasks.length;
    const line = taskList.querySelector('.planner-drop-line') || document.createElement('div');
    line.className = 'planner-drop-line';
    if (target < 0) taskList.append(line);
    else taskList.insertBefore(line, rows[target]);
  });

  taskList.addEventListener('drop', event => {
    if (!draggedTaskId || state.dropIndex === null) return;
    event.preventDefault();
    const from = state.tasks.findIndex(task => task.taskId === draggedTaskId);
    let target = state.dropIndex;
    if (from < 0) return;
    const [moved] = state.tasks.splice(from, 1);
    if (from < target) target -= 1;
    state.tasks.splice(Math.max(0, target), 0, moved);
    draggedTaskId = null;
    state.dropIndex = null;
    markTasksChanged();
  });

  async function moveTaskToNextDay(task) {
    const nextDate = dateFromKey(state.date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextKey = keyForDate(nextDate);
    setSaveState('Moving...');
    try {
      const nextResponse = await fetch(`/api/planner?date=${nextKey}`, { credentials: 'same-origin' });
      if (!nextResponse.ok) throw new Error('Unable to load next day');
      const nextData = await nextResponse.json();
      const nextTasks = (nextData.lists || []).flatMap(list => list.tasks || []);
      nextTasks.push(task);
      const moveResponse = await fetch('/api/planner', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: nextKey, lists: [{ listId: 'main', title: 'Todo', tasks: nextTasks }], note: nextData.note || '' })
      });
      if (!moveResponse.ok) throw new Error('Unable to save next day');
      state.tasks = state.tasks.filter(item => item.taskId !== task.taskId);
      markTasksChanged();
    } catch (error) {
      setSaveState('Could not move task');
      console.error('Planner move failed', error);
    }
  }

  function markTasksChanged() {
    localStorage.setItem(draftKey('tasks'), JSON.stringify(state.tasks));
    setSaveState('Saving...');
    renderTasks();
    clearTimeout(state.taskSaveTimer);
    state.taskSaveTimer = setTimeout(() => savePlanner(false), 700);
  }

  async function savePlanner(saveNote) {
    setSaveState('Saving...');
    try {
      const response = await fetch('/api/planner', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: state.date, lists: [{ listId: 'main', title: 'Todo', tasks: state.tasks }], note: saveNote ? state.note : state.savedNote })
      });
      if (!response.ok) throw new Error('Unable to save planner');
      localStorage.removeItem(draftKey('tasks'));
      if (saveNote) {
        state.savedNote = state.note;
        localStorage.removeItem(draftKey('note'));
        renderNote();
        state.noteEditing = false;
        updateEditMode();
      }
      setSaveState(saveNote ? 'Saved' : 'Tasks saved');
    } catch (error) { setSaveState('Could not save'); console.error('Planner save failed', error); }
  }

  async function loadDate(key) {
    state.date = key;
    state.noteEditing = false;
    const selected = dateFromKey(key);
    dateLabel.textContent = key === todayKey ? 'Today' : selected.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    dateInput.value = key;
    updateEditMode();
    setSaveState('Loading...');
    try {
      const response = await fetch(`/api/planner?date=${key}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Unable to load planner');
      const data = await response.json();
      const serverTasks = (data.lists || []).flatMap(list => list.tasks || []);
      let localTasks = null;
      try { localTasks = JSON.parse(localStorage.getItem(draftKey('tasks')) || 'null'); } catch (error) { localTasks = null; }
      state.tasks = Array.isArray(localTasks) ? localTasks : serverTasks;
      state.savedNote = data.note || '';
      state.note = localStorage.getItem(draftKey('note')) ?? state.savedNote;
      noteInput.value = state.note;
      renderNote();
      updateEditMode();
      renderTasks();
      setSaveState(localStorage.getItem(draftKey('tasks')) || localStorage.getItem(draftKey('note')) ? 'Unsaved local changes' : 'Saved');
    } catch (error) { setSaveState('Offline'); console.error('Planner load failed', error); }
  }

  taskForm.addEventListener('submit', event => {
    event.preventDefault();
    const title = taskInput.value.trim();
    if (!title) return;
    state.tasks.push({ taskId: makeId(), title: title.slice(0, 240), completed: false });
    taskInput.value = '';
    markTasksChanged();
  });
  noteInput.addEventListener('input', () => {
    if (!state.noteEditing) return;
    state.note = noteInput.value;
    localStorage.setItem(draftKey('note'), state.note);
    setSaveState('Saved locally');
  });
  noteSaveButton?.addEventListener('click', () => { if (state.noteEditing) savePlanner(true); });
  editButton?.addEventListener('click', () => {
    state.noteEditing = true;
    updateEditMode();
    noteInput.focus();
    setSaveState('Editing');
  });
  document.getElementById('planner-prev')?.addEventListener('click', () => { const date = dateFromKey(state.date); date.setDate(date.getDate() - 1); loadDate(keyForDate(date)); });
  document.getElementById('planner-next')?.addEventListener('click', () => { const date = dateFromKey(state.date); date.setDate(date.getDate() + 1); loadDate(keyForDate(date)); });
  dateInput.addEventListener('change', () => { if (dateInput.value) loadDate(dateInput.value); });
  datePickerButton?.addEventListener('click', () => { if (typeof dateInput.showPicker === 'function') dateInput.showPicker(); else dateInput.click(); });
  loadDate(todayKey);
})();
