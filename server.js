require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const dbConnect = require('./lib/dbConnect');
const User = require('./models/User');
const StudyLog = require('./models/StudyLog');
const FocusSession = require('./models/FocusSession');
const Achievement = require('./models/Achievement');
const PrivateGroup = require('./models/PrivateGroup');
const DailyPlanner = require('./models/DailyPlanner');
const { authenticateUser } = require('./middleware/auth');
const { achievementsList, router: achievementRouter } = require('./routes/achievements');

// Trigger the main app DB connection immediately to warm up the server
dbConnect()
  .then(() => StudyLog.updateMany(
    {
      hours: { $type: 'number', $gt: 0 },
      $or: [{ minutes: { $exists: false } }, { minutes: null }, { minutes: 0 }]
    },
    [{ $set: { minutes: { $round: [{ $multiply: ['$hours', 60] }, 2] } } }]
  ))
  .catch(err => console.error("Main DB Connection Error:", err));

const app = express();
const PORT = process.env.PORT || 3000;

// Essential for Vercel (Serverless)
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// Session Middleware - using mongoUrl for maximum stability
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI, // Safer than clientPromise for this setup
    ...(process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {}),
    ttl: 14 * 24 * 60 * 60, // 14 days
    autoRemove: 'native'
  }),
  cookie: {
    maxAge: 10 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax'
  }
}));

const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many requests from this IP, please try again after 15 minutes'
});

const usernameSuggestionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many username checks, please try again later'
});

// Optimized Ping Route
app.get('/ping', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      res.status(200).send('Pong - DB Connected');
    } else {
      await dbConnect();
      res.status(200).send('Pong - Waking Up DB');
    }
  } catch (e) {
    console.error(e);
    res.status(200).send('Pong - No DB');
  }
});

app.use('/api/achievements', achievementRouter);

app.get('/api/planner', authenticateUser, noCache, async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!isPlannerDate(date)) return res.status(400).json({ error: 'Invalid planner date' });
    await dbConnect();
    const part = String(req.query.part || 'all');
    const projection = part === 'tasks' ? 'lists' : part === 'note' ? 'note' : 'lists note';
    const planner = await DailyPlanner.findOne({ userId: req.session.userId, date }).select(projection).lean();
    if (part === 'tasks') return res.json({ date, lists: planner?.lists || [] });
    if (part === 'note') return res.json({ date, note: planner?.note || '' });
    res.json({ date, lists: planner?.lists || [], note: planner?.note || '' });
  } catch (error) {
    console.error('Planner load error:', error);
    res.status(500).json({ error: 'Unable to load planner' });
  }
});

app.get('/api/planner/calendar', authenticateUser, noCache, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isPlannerDate(from) || !isPlannerDate(to) || from > to) {
      return res.status(400).json({ error: 'Invalid planner range' });
    }
    await dbConnect();
    const planners = await DailyPlanner.find({
      userId: req.session.userId,
      date: { $gte: from, $lte: to }
    }).select('date lists note').lean();
    res.json(planners.map(planner => ({
      date: planner.date,
      taskCount: planner.lists.reduce((total, list) => total + list.tasks.length, 0),
      completedCount: planner.lists.reduce((total, list) => total + list.tasks.filter(task => task.completed).length, 0),
      hasNote: Boolean(planner.note?.trim())
    })));
  } catch (error) {
    console.error('Planner calendar error:', error);
    res.status(500).json({ error: 'Unable to load planner dates' });
  }
});

app.put('/api/planner', authenticateUser, noCache, async (req, res) => {
  try {
    const date = String(req.body.date || '');
    if (!isPlannerDate(date)) return res.status(400).json({ error: 'Invalid planner date' });
    await dbConnect();
    const planner = await DailyPlanner.findOneAndUpdate(
      { userId: req.session.userId, date },
      { $set: cleanPlanner(req.body) },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    res.json({ date: planner.date, lists: planner.lists, note: planner.note });
  } catch (error) {
    console.error('Planner save error:', error);
    res.status(500).json({ error: 'Unable to save planner' });
  }
});

// XP Logic
const XP_PER_HOUR = 10;
const XP_FOR_GOAL = 50;
const XP_FOR_ACHIEVEMENT = 100;
const XP_PER_LEVEL = 1000;

const getLogMinutes = (log) => {
  const minutes = Number(log.minutes);
  const hours = Number(log.hours);
  if (Number.isFinite(hours) && hours > 0 && (!Number.isFinite(minutes) || minutes <= 0)) {
    return Math.round(hours * 60 * 100) / 100;
  }
  return Number.isFinite(minutes) ? minutes : 0;
};
const getGoalMinutes = (user) => user.dailyGoalHours && user.dailyGoalMinutes === 300 && user.dailyGoalHours !== 5
  ? Math.round(user.dailyGoalHours * 60)
  : (user.dailyGoalMinutes || 300);

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();

const formatMinutes = (minutes, unit = 'minutes') => {
  const value = Number(minutes) || 0;
  if (unit === 'hours') {
    const hours = Math.round((value / 60) * 10) / 10;
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(value)}m`;
};

const plannerDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isPlannerDate = (value) => {
  if (!plannerDatePattern.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const cleanPlanner = (payload = {}) => ({
  lists: (Array.isArray(payload.lists) ? payload.lists : []).slice(0, 30).map(list => ({
    listId: String(list.listId || crypto.randomUUID()),
    title: String(list.title || 'Untitled list').trim().slice(0, 80) || 'Untitled list',
    tasks: (Array.isArray(list.tasks) ? list.tasks : []).slice(0, 100).map(task => ({
      taskId: String(task.taskId || crypto.randomUUID()),
      title: String(task.title || '').trim().slice(0, 240),
      completed: Boolean(task.completed)
    })).filter(task => task.title)
  })),
  note: String(payload.note || '').slice(0, 10000)
});

app.locals.formatMinutes = formatMinutes;

const usernameCandidate = (value) => normalizeUsername(value).replace(/[^a-z0-9_]/g, '').slice(0, 24);

const buildUsernameSuggestions = (name, email) => {
  const nameParts = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const firstName = usernameCandidate(nameParts[0]);
  const lastName = usernameCandidate(nameParts[nameParts.length - 1]);
  const emailName = usernameCandidate(String(email || '').split('@')[0]);
  const candidates = [
    { value: firstName && lastName ? `${firstName}_${lastName}` : firstName, score: 100 },
    { value: firstName && lastName ? `${firstName}${lastName}` : firstName, score: 96 },
    { value: firstName && lastName ? `${firstName[0]}${lastName}` : firstName, score: 92 },
    { value: emailName, score: 88 },
    { value: firstName ? `${firstName}_focus` : '', score: 80 },
    { value: lastName ? `${lastName}_focus` : '', score: 78 }
  ];
  const baseCandidates = [...candidates];
  [7, 21, 24, 42, new Date().getFullYear()].forEach(number => {
    baseCandidates.forEach(candidate => {
      if (candidate.value) candidates.push({ value: `${candidate.value}${number}`, score: candidate.score - 10 });
    });
  });
  return [...new Map(candidates
    .map(candidate => ({ ...candidate, value: usernameCandidate(candidate.value) }))
    .filter(candidate => candidate.value.length >= 3)
    .map(candidate => [candidate.value, candidate])).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
};

const makePrivateGroupCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

const getGroupPeriodStart = (range, now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === 'week') {
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else if (range === 'month') {
    start.setUTCDate(1);
  }
  return start;
};

const buildPrivateGroupStats = async (group) => {
  const members = await User.find({ _id: { $in: group.members } })
    .select('name username userId')
    .lean();
  const memberIds = members.map(member => member._id);
  const [sessions, logs] = await Promise.all([
    FocusSession.find({ userId: { $in: memberIds }, status: 'completed' })
      .select('userId startTime durationSeconds')
      .lean(),
    StudyLog.find({ userId: { $in: memberIds } })
      .select('userId date minutes hours')
      .lean()
  ]);
  const todayStart = getGroupPeriodStart('today');
  const weekStart = getGroupPeriodStart('week');
  const monthStart = getGroupPeriodStart('month');
  const stats = new Map(memberIds.map(id => [String(id), {
    todayMinutes: 0,
    weekMinutes: 0,
    monthMinutes: 0,
    totalMinutes: 0
  }]));

  sessions.forEach(session => {
    const memberStats = stats.get(String(session.userId));
    if (!memberStats) return;
    const minutes = session.durationSeconds / 60;
    const date = new Date(session.startTime);
    memberStats.totalMinutes += minutes;
    if (date >= weekStart) memberStats.weekMinutes += minutes;
    if (date >= monthStart) memberStats.monthMinutes += minutes;
    if (date >= todayStart) memberStats.todayMinutes += minutes;
  });

  logs.forEach(log => {
    const memberStats = stats.get(String(log.userId));
    if (!memberStats) return;
    const minutes = getLogMinutes(log);
    const date = new Date(log.date);
    memberStats.totalMinutes += minutes;
    if (date >= weekStart) memberStats.weekMinutes += minutes;
    if (date >= monthStart) memberStats.monthMinutes += minutes;
    if (date >= todayStart) memberStats.todayMinutes += minutes;
  });

  return members.map(member => ({
    ...member,
    ...(stats.get(String(member._id)) || { todayMinutes: 0, weekMinutes: 0, totalMinutes: 0 }),
    todayMinutes: Math.round(stats.get(String(member._id))?.todayMinutes || 0),
    weekMinutes: Math.round(stats.get(String(member._id))?.weekMinutes || 0),
    monthMinutes: Math.round(stats.get(String(member._id))?.monthMinutes || 0),
    totalMinutes: Math.round(stats.get(String(member._id))?.totalMinutes || 0)
  })).sort((a, b) => b.weekMinutes - a.weekMinutes || b.totalMinutes - a.totalMinutes);
};

const ensureUserIdentity = async (user) => {
  if (!user) return user;
  let changed = false;
  if (!user.userId) {
    user.userId = crypto.randomUUID();
    changed = true;
  }
  if (!user.username) {
    const base = normalizeUsername(user.name).replace(/[^a-z0-9_]/g, '').slice(0, 22) || 'focususer';
    let candidate = base;
    while (await User.exists({ username: candidate, _id: { $ne: user._id } })) {
      candidate = `${base.slice(0, 22)}${Math.floor(Math.random() * 100000)}`.slice(0, 30);
    }
    user.username = candidate;
    changed = true;
  }
  if (changed) await user.save();
  return user;
};

const getUTCDateKey = (date) => {
  const value = new Date(date);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
};

const buildCalendarLogs = (manualLogs, focusSessions) => {
  const days = new Map();
  manualLogs.forEach(log => {
    days.set(getUTCDateKey(log.date), { date: log.date, minutes: getLogMinutes(log) });
  });
  focusSessions.forEach(session => {
    const key = getUTCDateKey(session.startTime);
    const day = days.get(key) || { date: new Date(`${key}T00:00:00.000Z`), minutes: 0 };
    day.minutes += session.durationSeconds / 60;
    days.set(key, day);
  });
  return [...days.values()].map(day => ({
    date: day.date,
    minutes: Math.round(day.minutes * 100) / 100
  }));
};

const getTodayFocusMinutes = async (userId) => {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowUTC = new Date(todayUTC);
  tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);
  const [todayLog, todayFocusSessions] = await Promise.all([
    StudyLog.findOne({ userId, date: { $gte: todayUTC, $lt: tomorrowUTC } }),
    FocusSession.find({
      userId,
      status: 'completed',
      startTime: { $gte: todayUTC, $lt: tomorrowUTC }
    }).select('durationSeconds')
  ]);
  const focusMinutes = todayFocusSessions.reduce((sum, session) => sum + session.durationSeconds / 60, 0);
  return (todayLog ? getLogMinutes(todayLog) : 0) + focusMinutes;
};

const syncFocusStats = async (userId, logs = null) => {
  const studyLogs = logs || await StudyLog.find({ userId }).sort({ date: 'asc' });
  const focusSessions = await FocusSession.find({ userId, status: 'completed' }).select('durationSeconds startTime');
  let totalFocusMinutes = focusSessions.reduce((sum, session) => sum + session.durationSeconds / 60, 0);
  let firstLogDate = focusSessions.reduce((firstDate, session) => (
    !firstDate || session.startTime < firstDate ? session.startTime : firstDate
  ), null);

  for (const log of studyLogs) {
    const minutes = getLogMinutes(log);
    if (!log.minutes && typeof log.hours === 'number') {
      log.minutes = minutes;
      await log.save();
    }
    if (!firstLogDate || log.date < firstLogDate) firstLogDate = log.date;
  }

  const elapsedDays = firstLogDate
    ? Math.max(1, Math.ceil((Date.now() - firstLogDate.getTime()) / (1000 * 60 * 60 * 24)) + 1)
    : 0;
  const elapsedWeeks = elapsedDays ? Math.max(1, elapsedDays / 7) : 0;
  const elapsedMonths = elapsedDays ? Math.max(1, elapsedDays / 30.4375) : 0;

  totalFocusMinutes = Math.round((totalFocusMinutes + studyLogs.reduce((sum, log) => sum + getLogMinutes(log), 0)) * 100) / 100;
  const averageWeeklyFocusMinutes = elapsedWeeks ? Math.round(totalFocusMinutes / elapsedWeeks) : 0;
  const averageMonthlyFocusMinutes = elapsedMonths ? Math.round(totalFocusMinutes / elapsedMonths) : 0;

  await User.findByIdAndUpdate(userId, {
    totalFocusMinutes,
    averageWeeklyFocusMinutes,
    averageMonthlyFocusMinutes
  });

  return { totalFocusMinutes, averageWeeklyFocusMinutes, averageMonthlyFocusMinutes };
};

const calculateXpAndLevel = async (userId, userDoc = null, logsDoc = null, achievementsDoc = null) => {
  if (!userDoc || !logsDoc || !achievementsDoc) await dbConnect();

  const user = userDoc || await User.findById(userId);
  if (!user) return { xp: 0, level: 1 };

  let allLogs = logsDoc;
  let achievements = achievementsDoc;

  if (!allLogs || !achievements) {
    const results = await Promise.all([
      !allLogs ? StudyLog.find({ userId }) : null,
      !achievements ? Achievement.find({ userId, achieved: true }) : null
    ]);
    if (!allLogs) allLogs = results[0];
    if (!achievements) achievements = results[1];
  } else {
    achievements = achievements.filter(a => a.achieved);
  }

  let xpFromLogs = 0;
  if (allLogs) {
      allLogs.forEach(log => {
        const logMinutes = getLogMinutes(log);
        xpFromLogs += (logMinutes / 60) * XP_PER_HOUR;
        if (logMinutes >= getGoalMinutes(user)) {
          xpFromLogs += XP_FOR_GOAL;
        }
      });
  }

  const xpFromAchievements = achievements ? achievements.length * XP_FOR_ACHIEVEMENT : 0;
  const totalXp = Math.round(xpFromLogs + xpFromAchievements);
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;
  return { xp: totalXp, level: Math.min(level, 100) };
};

const calculateLongestStreak = (logs) => {
  if (!logs || logs.length === 0) return 0;
  if (logs.length === 1) return 1;
  let maxStreak = 1;
  let currentStreak = 1;
  for (let i = 1; i < logs.length; i++) {
    const prevDate = logs[i - 1].date;
    const currentDate = logs[i].date;
    const diffInDays = (currentDate.getTime() - prevDate.getTime()) / (1000 * 3600 * 24);
    if (diffInDays === 1) {
      currentStreak++;
    } else if (diffInDays > 1) {
      currentStreak = 1;
    }
    maxStreak = Math.max(maxStreak, currentStreak);
  }
  return maxStreak;
};

const calculateCurrentStreak = (logs) => {
  if (!logs || logs.length === 0) return 0;
  let currentStreak = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const logDates = new Set(logs.map(log => log.date.getTime()));
  let currentDate = logDates.has(today.getTime()) ? today : new Date(new Date().setUTCDate(today.getUTCDate() - 1));
  currentDate.setUTCHours(0, 0, 0, 0);
  while (logDates.has(currentDate.getTime())) {
    currentStreak++;
    currentDate.setUTCDate(currentDate.getUTCDate() - 1);
  }
  return currentStreak;
};

const reevaluateAchievements = async (userId, userDoc = null, logsDoc = null, currentAchievements = null) => {
  await dbConnect();

  const user = userDoc || await User.findById(userId);
  if (!user) return [];

  const allLogs = logsDoc || await StudyLog.find({ userId }).sort({ date: 'asc' });
  const userAchievements = currentAchievements || await Achievement.find({ userId });

  const achievedIds = new Set(userAchievements.map(a => a.achievementId));
  const newUnlocks = [];

  for (const achievement of achievementsList) {
    const isAchievedInDB = achievedIds.has(achievement.id);
    const userQualifies = achievement.check(allLogs, user);

    if (userQualifies && !isAchievedInDB) {
      const newAch = {
        userId,
        achievementId: achievement.id,
        name: achievement.name,
        description: achievement.description,
        achieved: true,
        dateAchieved: new Date(),
        notified: false,
        goalValueOnAchieved: achievement.type === 'goal' ? getGoalMinutes(user) : undefined,
      };
      newUnlocks.push(newAch);
    } else if (!userQualifies && isAchievedInDB) {
      await Achievement.deleteOne({ userId, achievementId: achievement.id });
    }
  }

  if (newUnlocks.length > 0) {
    await Achievement.insertMany(newUnlocks);
  }

  return newUnlocks;
};

// Routes
app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('index');
});

app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.get('/signup', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('signup', { error: null, errors: [] });
});

app.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  try {
    await dbConnect();
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.render('login', { error: 'Invalid email or password' });
    }
    await ensureUserIdentity(user);
    req.session.userId = user._id;
    req.session.save((err) => {
      if (err) {
        console.error("Session Save Error:", err);
        return res.render('login', { error: 'Server error occurred' });
      }
      res.redirect('/dashboard');
    });
  } catch (err) {
      console.error(err);
      res.render('login', { error: 'Login failed' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/api/username-suggestions', usernameSuggestionLimiter, async (req, res) => {
  try {
    await dbConnect();
    const requestedUsername = usernameCandidate(req.query.username);
    const candidates = buildUsernameSuggestions(req.query.name, req.query.email);
    const values = [...new Set([
      requestedUsername,
      ...candidates.map(candidate => candidate.value)
    ].filter(value => value.length >= 3))];
    const takenUsers = await User.find({ username: { $in: values } }).select('username').lean();
    const taken = new Set(takenUsers.map(user => user.username));
    res.json({
      available: requestedUsername.length >= 3 && !taken.has(requestedUsername),
      suggestions: candidates
        .filter(candidate => !taken.has(candidate.value))
        .slice(0, 5)
        .map(candidate => candidate.value)
    });
  } catch (error) {
    console.error('Username suggestion error:', error);
    res.status(500).json({ error: 'Unable to check username' });
  }
});

app.post('/signup', authLimiter, [
  body('name').trim().escape(),
  body('username').trim().toLowerCase().matches(/^[a-z0-9_]{3,30}$/),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  })
], async (req, res) => {
  await dbConnect();
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('signup', { error: 'Invalid data provided', errors: errors.array() });
  }
  try {
    const { name, username, email, password } = req.body;
    if (await User.findOne({ email })) {
      return res.render('signup', { error: 'Email already registered', errors: [] });
    }
    if (await User.findOne({ username: normalizeUsername(username) })) {
      return res.render('signup', { error: 'Username is already taken', errors: [] });
    }
    const user = new User({ name, username: normalizeUsername(username), email, password });
    await user.save();
    req.session.userId = user._id;
    req.session.save((err) => {
      if (err) {
        console.error(err);
        return res.render('signup', { error: 'Server error occurred', errors: [] });
      }
      res.redirect('/dashboard');
    });
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
      return res.render('signup', { error: 'Username or email is already registered', errors: [] });
    }
    res.render('signup', { error: 'Server error occurred', errors: [] });
  }
});

app.get('/dashboard', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievements] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }).sort({ date: 'asc' }),
      Achievement.find({ userId })
    ]);

    if (!user) {
      return req.session.destroy(() => {
        res.redirect('/login');
      });
    }

    await ensureUserIdentity(user);

    const focusStats = await syncFocusStats(userId, allLogs);
    Object.assign(user, focusStats);

    const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const todayLog = allLogs.find(log => log.date.getTime() === todayUTC.getTime());
    const tomorrowUTC = new Date(todayUTC);
    tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);
    const todayFocusSessions = await FocusSession.find({
      userId,
      status: 'completed',
      startTime: { $gte: todayUTC, $lt: tomorrowUTC }
    }).select('durationSeconds');
    const todayFocusSeconds = todayFocusSessions.reduce((sum, session) => sum + session.durationSeconds, 0);
    const todayMinutes = (todayLog ? getLogMinutes(todayLog) : 0) + todayFocusSeconds / 60;

    const thirtyDaysAgo = new Date(todayUTC);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const recentLogs = allLogs
      .filter(log => log.date >= thirtyDaysAgo)
      .sort((a, b) => b.date - a.date);

    const { totalRange = 'alltime' } = req.query;
    let totalMinutes = user.totalFocusMinutes || 0;

    if (totalRange === 'alltime') {
      totalMinutes = user.totalFocusMinutes || 0;
    } else {
      let startDate = null;
      if (totalRange === '7days') {
        startDate = new Date(todayUTC);
        startDate.setUTCDate(startDate.getUTCDate() - 7);
      } else if (totalRange === '1month') {
        startDate = new Date(todayUTC);
        startDate.setUTCMonth(startDate.getUTCMonth() - 1);
      } else if (totalRange === '6months') {
        startDate = new Date(todayUTC);
        startDate.setUTCMonth(startDate.getUTCMonth() - 6);
      }

      if (startDate) {
        totalMinutes = allLogs
          .filter(log => log.date >= startDate)
          .reduce((acc, log) => acc + getLogMinutes(log), 0);
      }
    }

    const achievementCount = achievements.filter(a => a.achieved && !a.notified).length;

    const consistencyLogs = allLogs.filter(log => getLogMinutes(log) > 0);
    const goalLogs = allLogs.filter(log => getLogMinutes(log) >= getGoalMinutes(user));
    const currentConsistencyStreak = calculateCurrentStreak(consistencyLogs);
    const currentGoalStreak = calculateCurrentStreak(goalLogs);
    const maxConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const maxGoalStreak = calculateLongestStreak(goalLogs);

    res.render('dashboard', {
      user,
      todayMinutes,
      todayLogMinutes: todayLog ? getLogMinutes(todayLog) : 0,
      todayFocusSeconds,
      recentLogs,
      totalMinutes,
      totalRange,
      achievementCount,
      currentConsistencyStreak,
      currentGoalStreak,
      maxConsistencyStreak,
      maxGoalStreak
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/api/xp-history', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [achievements, studyLogs] = await Promise.all([
      Achievement.find({ userId, achieved: true }).sort({ dateAchieved: 'desc' }),
      StudyLog.find({ userId }).sort({ date: 'desc' })
    ]);

    const achievementHistory = achievements.map(ach => `+${XP_FOR_ACHIEVEMENT} XP: Achievement unlocked - "${ach.name}"`);
    const logHistory = [];
    studyLogs.forEach(log => {
      const logMinutes = getLogMinutes(log);
      logHistory.push(`+${Math.round((logMinutes / 60) * XP_PER_HOUR)} XP: Focused for ${logMinutes} minutes on ${log.date.toLocaleDateString()}`);
      if (logMinutes >= getGoalMinutes(user)) {
        logHistory.push(`+${XP_FOR_GOAL} XP: Daily goal met on ${log.date.toLocaleDateString()}`);
      }
    });
    res.json({ achievements: achievementHistory, logs: logHistory });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error fetching XP history' });
  }
});

app.post('/api/focus-sessions', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const { sessionId, startTime, endTime, durationSeconds, durationMinutes, status = 'completed' } = req.body;
    const parsedStart = new Date(startTime);
    const parsedEnd = new Date(endTime);
    const elapsedSeconds = Math.round((parsedEnd.getTime() - parsedStart.getTime()) / 1000);
    const hasRoundedMinutes = durationMinutes !== undefined;
    const parsedMinutes = Number(durationMinutes);
    const parsedDuration = hasRoundedMinutes ? parsedMinutes * 60 : Number(durationSeconds);
    const validRoundedDuration = Number.isInteger(parsedMinutes) && parsedMinutes >= 0 &&
      parsedDuration === parsedMinutes * 60 && parsedMinutes === Math.round(elapsedSeconds / 60);
    const validExactDuration = Number.isInteger(parsedDuration) && parsedDuration >= 0 &&
      parsedDuration === elapsedSeconds;

    if (!sessionId || status !== 'completed' || Number.isNaN(parsedStart.getTime()) ||
        Number.isNaN(parsedEnd.getTime()) || parsedEnd < parsedStart ||
        !(hasRoundedMinutes ? validRoundedDuration : validExactDuration)) {
      return res.status(400).json({ error: 'Invalid focus session' });
    }

    const userId = req.session.userId;
    const savedSession = await FocusSession.findOneAndUpdate(
      { userId, sessionId },
      {
        $setOnInsert: {
          userId,
          sessionId,
          startTime: parsedStart,
          endTime: parsedEnd,
          durationSeconds: parsedDuration,
          status,
          source: 'dashboard-timer'
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const [focusStats, todayMinutes] = await Promise.all([
      syncFocusStats(userId),
      getTodayFocusMinutes(userId)
    ]);
    res.status(200).json({ success: true, sessionId: savedSession.sessionId, todayMinutes, ...focusStats });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await FocusSession.findOne({ userId: req.session.userId, sessionId: req.body.sessionId });
      if (existing) {
        const [focusStats, todayMinutes] = await Promise.all([
          syncFocusStats(req.session.userId),
          getTodayFocusMinutes(req.session.userId)
        ]);
        return res.status(200).json({ success: true, sessionId: existing.sessionId, todayMinutes, ...focusStats });
      }
    }
    console.error('Focus session save error:', error);
    res.status(500).json({ error: 'Unable to save focus session' });
  }
});

app.get('/api/calendar/day', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(Date.UTC(year, month - 1, day));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const userId = req.session.userId;
    const [user, log, sessions, planner, groups] = await Promise.all([
      User.findById(userId).select('name username publicProfile dailyGoalMinutes timeUnit').lean(),
      StudyLog.findOne({ userId, date: dayStart }).lean(),
      FocusSession.find({ userId, status: 'completed', startTime: { $gte: dayStart, $lt: dayEnd } }).select('durationSeconds').lean(),
      DailyPlanner.findOne({ userId, date }).lean(),
      PrivateGroup.find({ members: userId }).select('name members').lean()
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const loggedMinutes = getLogMinutes(log || { minutes: 0 });
    const timerMinutes = sessions.reduce((total, session) => total + session.durationSeconds / 60, 0);
    const totalMinutes = Math.round(loggedMinutes + timerMinutes);
    const goalMinutes = user.dailyGoalMinutes || 300;
    const tasks = (planner?.lists || []).flatMap(list => list.tasks || []).map(task => ({
      title: task.title,
      completed: Boolean(task.completed)
    }));

    let publicRank = null;
    if (user.publicProfile) {
      const publicUsers = await User.find({ publicProfile: true }).select('_id username').lean();
      const publicIds = publicUsers.map(publicUser => publicUser._id);
      const [publicSessions, publicLogs] = await Promise.all([
        FocusSession.aggregate([
          { $match: { userId: { $in: publicIds }, status: 'completed', startTime: { $gte: dayStart, $lt: dayEnd } } },
          { $group: { _id: '$userId', seconds: { $sum: '$durationSeconds' } } }
        ]),
        StudyLog.find({ userId: { $in: publicIds }, date: dayStart }).select('userId minutes hours').lean()
      ]);
      const totals = new Map(publicIds.map(id => [String(id), 0]));
      publicSessions.forEach(item => totals.set(String(item._id), (totals.get(String(item._id)) || 0) + item.seconds / 60));
      publicLogs.forEach(item => totals.set(String(item.userId), (totals.get(String(item.userId)) || 0) + getLogMinutes(item)));
      const ranked = publicUsers.map(publicUser => ({ id: String(publicUser._id), username: publicUser.username, minutes: totals.get(String(publicUser._id)) || 0 }))
        .filter(item => item.minutes > 0)
        .sort((first, second) => second.minutes - first.minutes || first.username.localeCompare(second.username));
      const index = ranked.findIndex(item => item.id === String(userId));
      if (index >= 0) publicRank = { rank: index + 1, total: ranked.length };
    }

    const groupRanks = [];
    for (const group of groups) {
      const members = await User.find({ _id: { $in: group.members } }).select('_id username').lean();
      const memberIds = members.map(member => member._id);
      const [groupSessions, groupLogs] = await Promise.all([
        FocusSession.aggregate([
          { $match: { userId: { $in: memberIds }, status: 'completed', startTime: { $gte: dayStart, $lt: dayEnd } } },
          { $group: { _id: '$userId', seconds: { $sum: '$durationSeconds' } } }
        ]),
        StudyLog.find({ userId: { $in: memberIds }, date: dayStart }).select('userId minutes hours').lean()
      ]);
      const totals = new Map(memberIds.map(id => [String(id), 0]));
      groupSessions.forEach(item => totals.set(String(item._id), (totals.get(String(item._id)) || 0) + item.seconds / 60));
      groupLogs.forEach(item => totals.set(String(item.userId), (totals.get(String(item.userId)) || 0) + getLogMinutes(item)));
      const ranked = members.map(member => ({ id: String(member._id), minutes: totals.get(String(member._id)) || 0 }))
        .sort((first, second) => second.minutes - first.minutes);
      const index = ranked.findIndex(item => item.id === String(userId));
      if (index >= 0) groupRanks.push({ name: group.name, rank: index + 1, total: ranked.length });
    }

    res.json({ date, totalMinutes, goalMinutes, percentage: Math.min(100, Math.round((totalMinutes / goalMinutes) * 100)), tasks, completedTasks: tasks.filter(task => task.completed).length, note: planner?.note || '', publicRank, groupRanks });
  } catch (error) {
    console.error('Calendar day details error:', error);
    res.status(500).json({ error: 'Unable to load calendar day' });
  }
});

app.get('/api/calendar/data', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const [year, month] = String(req.query.month || '').split('-').map(Number);
    if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'Invalid calendar month' });

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 1));
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    const [monthLogs, monthFocusSessions, yearLogs, yearFocusSessions] = await Promise.all([
      StudyLog.find({ userId: req.session.userId, date: { $gte: monthStart, $lt: monthEnd } }).lean(),
      FocusSession.find({ userId: req.session.userId, status: 'completed', startTime: { $gte: monthStart, $lt: monthEnd } }).select('startTime durationSeconds').lean(),
      StudyLog.find({ userId: req.session.userId, date: { $gte: yearStart, $lt: yearEnd } }).lean(),
      FocusSession.find({ userId: req.session.userId, status: 'completed', startTime: { $gte: yearStart, $lt: yearEnd } }).select('startTime durationSeconds').lean()
    ]);

    res.json({
      logs: buildCalendarLogs(monthLogs, monthFocusSessions),
      yearLogs: buildCalendarLogs(yearLogs, yearFocusSessions)
    });
  } catch (error) {
    console.error('Calendar data error:', error);
    res.status(500).json({ error: 'Unable to load calendar data' });
  }
});

app.get('/calendar', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    let currentMonth;
    if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      currentMonth = new Date(Date.UTC(year, month - 1, 1));
    } else {
      const now = new Date();
      currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }
    currentMonth.setUTCHours(0, 0, 0, 0);

    const user = await User.findById(userId).select('userId name username createdAt dailyGoalMinutes timeUnit publicProfile').lean();

    if (!user) {
      return req.session.destroy(() => { res.redirect('/login'); });
    }

    res.render('calendar', {
      user,
      logs: [],
      weekLogs: [],
      yearLogs: [],
      currentMonth,
      error: null,
      partial: req.query.partial === 'true'
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/add-study-log', authenticateUser, noCache, [
  body('date').isISO8601(),
  body('minutes').isFloat({ min: 0, max: 1440 }),
  body('mode').optional().default('add').isIn(['add', 'reset'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).send('Invalid data provided');
  }
  try {
    await dbConnect();
    const { date, minutes, mode } = req.body;
    const [year, month, day] = date.split('-').map(Number);
    const logDate = new Date(Date.UTC(year, month - 1, day));

    const userId = req.session.userId;
    const existingLog = await StudyLog.findOne({ userId, date: logDate });
    const dayEnd = new Date(logDate);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const focusSessions = await FocusSession.find({
      userId,
      status: 'completed',
      startTime: { $gte: logDate, $lt: dayEnd }
    }).select('durationSeconds');
    const timerMinutes = focusSessions.reduce((sum, session) => sum + session.durationSeconds / 60, 0);
    const manualMinutes = getLogMinutes(existingLog || { minutes: 0 });
    const inputUnit = req.body.timeUnit === 'hours' ? 'hours' : 'minutes';
    const inputValue = Number(minutes);
    if (inputUnit === 'hours' && inputValue > 24) return res.status(400).send('Invalid time value');
    const inputMinutes = inputUnit === 'hours' ? inputValue * 60 : inputValue;
    if (mode === 'reset') {
      await FocusSession.deleteMany({
        userId,
        status: 'completed',
        startTime: { $gte: logDate, $lt: dayEnd }
      });
    }
    const nextManualMinutes = mode === 'add' ? manualMinutes + inputMinutes : inputMinutes;

    await StudyLog.findOneAndUpdate(
      { userId, date: logDate },
      { $set: { minutes: Math.round(nextManualMinutes) } },
      { upsert: true, new: true }
    );

    await syncFocusStats(req.session.userId);
    await reevaluateAchievements(req.session.userId);

    if (req.xhr || String(req.headers.accept || '').includes('json')) {
      const today = new Date();
      const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const tomorrow = new Date(todayStart);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const todaySessions = await FocusSession.find({ userId, status: 'completed', startTime: { $gte: todayStart, $lt: tomorrow } }).select('durationSeconds');
      return res.status(200).json({
        success: true,
        logDate: date,
        inputMinutes,
        mode,
        reset: mode === 'reset',
        resetDate: date,
        todayFocusSeconds: todaySessions.reduce((sum, session) => sum + session.durationSeconds, 0),
        resetFocusSeconds: mode === 'reset' ? Math.round(inputMinutes * 60) : null
      });
    }

    res.redirect('/calendar');
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/update-goal', authenticateUser, noCache, [
  body('dailyGoalMinutes').isFloat({ min: 0.1, max: 1440 }),
  body('timeUnit').optional().isIn(['minutes', 'hours'])
], async (req, res) => {
  await dbConnect();
  const userId = req.session.userId;

  const [user, allLogs, achievements] = await Promise.all([
    User.findById(userId),
    StudyLog.find({ userId }),
    Achievement.find({ userId })
  ]);

  if (!user) {
    return req.session.destroy(() => { res.redirect('/login'); });
  }

  const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
  user.xp = xpData.xp;
  user.level = xpData.level;

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.redirect('/settings?profileError=Invalid%20goal%20value');
  }

  try {
    const inputValue = Number(req.body.dailyGoalMinutes);
    const inputUnit = req.body.timeUnit === 'hours' ? 'hours' : 'minutes';
    user.dailyGoalMinutes = Math.round((inputUnit === 'hours' ? inputValue * 60 : inputValue) * 10) / 10;
    await user.save();

    await reevaluateAchievements(userId, user, allLogs, achievements);

    res.redirect('/settings?profileSuccess=Goal%20updated%20successfully');
  } catch (error) {
    console.error(error);
    res.redirect('/settings?profileError=Error%20updating%20goal');
  }
});

app.post('/update-time-preference', authenticateUser, noCache, [
  body('timeUnit').isIn(['minutes', 'hours'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.redirect('/settings?profileError=Invalid%20time%20preference');
    await dbConnect();
    await User.findByIdAndUpdate(req.session.userId, { timeUnit: req.body.timeUnit });
    res.redirect('/settings?profileSuccess=Time%20preference%20updated');
  } catch (error) {
    console.error('Time preference update error:', error);
    res.redirect('/settings?profileError=Unable%20to%20update%20time%20preference');
  }
});

app.get('/achievements', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievedDocs] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }).sort({ date: 'asc' }),
      Achievement.find({ userId })
    ]);

    if (!user) {
      return req.session.destroy(() => { res.redirect('/login'); });
    }

    const newUnlocks = await reevaluateAchievements(userId, user, allLogs, achievedDocs);

    const fullAchievedList = [...achievedDocs, ...newUnlocks];

    const xpData = await calculateXpAndLevel(userId, user, allLogs, fullAchievedList);
    user.xp = xpData.xp;
    user.level = xpData.level;

    const consistencyLogs = allLogs.filter(log => getLogMinutes(log) > 0);
    const goalLogs = allLogs.filter(log => getLogMinutes(log) >= getGoalMinutes(user));

    const longestConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const longestGoalStreak = calculateLongestStreak(goalLogs);
    const totalFocusMinutes = user.totalFocusMinutes || 0;

    const achievedIds = new Set(fullAchievedList.map(a => a.achievementId));
    const allAchievements = achievementsList.map(ach => {
      const isAchieved = achievedIds.has(ach.id);
      const doc = isAchieved ? fullAchievedList.find(d => d.achievementId === ach.id) : null;
      return { ...ach, achieved: isAchieved, goalValueOnAchieved: doc ? doc.goalValueOnAchieved : null };
    });

    const completed = allAchievements.filter(a => a.achieved);
    const yetToCompleteConsistency = allAchievements.filter(a => !a.achieved && a.type === 'consistency');
    const yetToCompleteGoal = allAchievements.filter(a => !a.achieved && a.type === 'goal');
    const yetToCompleteHours = allAchievements.filter(a => !a.achieved && a.type === 'total_hours');

    res.render('achievements', {
      user,
      completed,
      yetToCompleteConsistency,
      yetToCompleteGoal,
      yetToCompleteHours,
      longestConsistencyStreak,
      longestGoalStreak,
      totalFocusMinutes,
      achievementsList
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/analytics', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievements] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }).sort({ date: 1 }),
      Achievement.find({ userId, achieved: true })
    ]);

    if (!user) {
      return req.session.destroy(() => { res.redirect('/login'); });
    }

    const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const thirtyDaysAgo = new Date(todayUTC);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

    const recentLogs = allLogs.filter(log => log.date >= thirtyDaysAgo);

    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    res.render('analytics', {
      user,
      logs: recentLogs,
      currentMonthTotal: allLogs
        .filter(log => log.date >= startOfMonth && log.date < nextMonth)
        .reduce((sum, log) => sum + getLogMinutes(log), 0),
      currentMonthAvg: user.averageMonthlyFocusMinutes
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/api/analytics', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;
    await syncFocusStats(userId);
    const { chart, startDate, endDate, month, range } = req.query;
    let data = [];
    const userObjectId = new mongoose.Types.ObjectId(String(userId));

    switch (chart) {
      case 'dateRange':
        data = await StudyLog.find({ userId, date: { $gte: new Date(startDate), $lte: new Date(endDate) } }).sort({ date: 'asc' });
        break;
      case 'monthly':
        const [year, monthNum] = month.split('-').map(Number);
        const firstDay = new Date(Date.UTC(year, monthNum - 1, 1));
        const lastDay = new Date(Date.UTC(year, monthNum, 0));
        data = await StudyLog.find({ userId, date: { $gte: firstDay, $lte: lastDay } }).sort({ date: 'asc' });
        break;
      case 'dayOfWeek':
        const [yearD, monthNumD] = month.split('-').map(Number);
        const firstDayD = new Date(Date.UTC(yearD, monthNumD - 1, 1));
        const lastDayD = new Date(Date.UTC(yearD, monthNumD, 0));
        data = await StudyLog.aggregate([
          { $match: { userId: userObjectId, date: { $gte: firstDayD, $lte: lastDayD } } },
          { $group: { _id: { $dayOfWeek: "$date" }, avgMinutes: { $avg: "$minutes" } } },
          { $sort: { _id: 1 } }
        ]);
        break;
      case 'goalAchievement':
        const [yearG, monthNumG] = month.split('-').map(Number);
        const firstDayG = new Date(Date.UTC(yearG, monthNumG - 1, 1));
        const lastDayG = new Date(Date.UTC(yearG, monthNumG, 0));
        const userGoal = await User.findById(userId);
        const logs = await StudyLog.find({ userId, date: { $gte: firstDayG, $lte: lastDayG } });
        const met = logs.filter(log => getLogMinutes(log) >= getGoalMinutes(userGoal)).length;
        const notMet = logs.length - met;
        data = { met, notMet };
        break;

      case 'distribution':
        const userDist = await User.findById(req.session.userId);
        if (!userDist) return res.status(401).json({ error: 'User not found' });

        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        let matchQuery = { userId: userDist._id };
        let label = 'Total Minutes';
        let isAverage = false;

        if (range === 'past_7_days' || range === 'average_7_days') {
          const d = new Date(todayUTC);
          d.setUTCDate(d.getUTCDate() - 7);
          matchQuery.date = { $gte: d };
          label = range.includes('average') ? 'Avg (7 Days)' : 'Total (7 Days)';
          isAverage = range.includes('average');

        } else if (range === 'recent_30_days' || range === 'average_30_days') {
          const d = new Date(todayUTC);
          d.setUTCDate(d.getUTCDate() - 30);
          matchQuery.date = { $gte: d };
          label = range.includes('average') ? 'Avg (30 Days)' : 'Total (30 Days)';
          isAverage = range.includes('average');

        } else if (range === 'past_6_months') {
          const d = new Date(todayUTC);
          d.setUTCMonth(d.getUTCMonth() - 6);
          matchQuery.date = { $gte: d };
          label = 'Total (6 Months)';
          isAverage = false;

        } else if (range === 'all_time_hours' || range === 'average_all_time') {
          label = range.includes('average') ? 'Avg (All Time)' : 'Total (All Time)';
          isAverage = range.includes('average');
        }

        if (range === 'average_7_days') {
          data = [{ label, value: userDist.averageWeeklyFocusMinutes || 0 }];
          break;
        }
        if (range === 'average_30_days') {
          data = [{ label, value: userDist.averageMonthlyFocusMinutes || 0 }];
          break;
        }

        const aggResult = await StudyLog.aggregate([
          { $match: matchQuery },
          { $group: { _id: null, total: { $sum: '$minutes' }, count: { $sum: 1 } } }
        ]);

        const resObj = aggResult[0] || { total: 0, count: 0 };
        let finalVal = resObj.total;

        if (isAverage) {
          finalVal = resObj.count > 0 ? resObj.total / resObj.count : 0;
        }

        data = [{ label: label, value: parseFloat(finalVal.toFixed(2)) }];
        break;

      case 'monthly_history':
        data = await StudyLog.aggregate([
          { $match: { userId: userObjectId } },
          {
            $group: {
              _id: { year: { $year: "$date" }, month: { $month: "$date" } },
              total: { $sum: "$minutes" }
            }
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } }
        ]);
        break;

      default:
        return res.status(400).json({ error: 'Invalid chart type' });
    }
    res.json(data);
  } catch (error) {
    console.error('Analytics API error:', error);
    res.status(500).json({ error: 'Server error', data: [] });
  }
});

const leaderboardRanges = new Set(['daily', 'weekly', 'monthly', 'yearly']);

const getLeaderboardStart = (range, now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === 'daily') return start;
  if (range === 'weekly') {
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else if (range === 'monthly') {
    start.setUTCDate(1);
  } else if (range === 'yearly') {
    start.setUTCMonth(0, 1);
  }
  return start;
};

app.get('/api/leaderboards', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const range = String(req.query.range || 'daily');
    if (!leaderboardRanges.has(range)) return res.status(400).json({ error: 'Invalid leaderboard range' });
    const start = getLeaderboardStart(range);
    const end = new Date(start);
    if (range === 'daily') end.setUTCDate(end.getUTCDate() + 1);
    if (range === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
    if (range === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
    if (range === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1);

    const [publicUsers, currentUser] = await Promise.all([
      User.find({ publicProfile: true }).select('_id username').lean(),
      User.findById(req.session.userId).select('_id publicProfile').lean()
    ]);
    const publicUserIds = publicUsers.map(user => user._id);
    const [sessions, logs] = await Promise.all([
      FocusSession.aggregate([
        { $match: { userId: { $in: publicUserIds }, status: 'completed', startTime: { $gte: start, $lt: end } } },
        { $group: { _id: '$userId', totalSeconds: { $sum: '$durationSeconds' } } }
      ]),
      StudyLog.find({ userId: { $in: publicUserIds }, date: { $gte: start, $lt: end } })
        .select('userId minutes hours')
        .lean()
    ]);
    const totals = new Map(publicUsers.map(user => [String(user._id), 0]));
    sessions.forEach(session => totals.set(String(session._id), (totals.get(String(session._id)) || 0) + session.totalSeconds));
    logs.forEach(log => totals.set(String(log.userId), (totals.get(String(log.userId)) || 0) + getLogMinutes(log) * 60));
    const rankedRows = publicUsers
      .map(user => ({ username: user.username, totalSeconds: totals.get(String(user._id)) || 0 }))
      .filter(row => row.totalSeconds > 0)
      .sort((first, second) => second.totalSeconds - first.totalSeconds || first.username.localeCompare(second.username))
      .map((row, index) => ({ rank: index + 1, ...row }));
    const topRows = range === 'daily' ? rankedRows.slice(0, 50) : rankedRows.slice(0, 100);
    const currentPublicUser = currentUser?.publicProfile
      ? publicUsers.find(user => String(user._id) === String(currentUser._id))
      : null;
    const currentRow = currentPublicUser
      ? rankedRows.find(row => row.username === currentPublicUser.username)
      : null;
    const rows = currentRow && !topRows.some(row => row.rank === currentRow.rank)
      ? [...topRows, { ...currentRow, isCurrentUser: true }]
      : topRows.map(row => ({ ...row, isCurrentUser: currentUser?.publicProfile && row.rank === currentRow?.rank }));
    res.json(rows);
  } catch (error) {
    console.error('Leaderboard API error:', error);
    res.status(500).json({ error: 'Unable to load leaderboard' });
  }
});

app.get('/leaderboards', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const user = await User.findById(req.session.userId);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);
    res.render('leaderboards', { user });
  } catch (error) {
    console.error('Leaderboards page error:', error);
    res.status(500).send('Server error');
  }
});

app.get('/private-groups', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const [user, groups] = await Promise.all([
      User.findById(req.session.userId),
      PrivateGroup.find({ members: req.session.userId }).sort({ updatedAt: 'desc' }).lean()
    ]);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);
    res.render('private-groups', {
      user,
      groups,
      error: req.query.error || null
    });
  } catch (error) {
    console.error('Private groups page error:', error);
    res.status(500).send('Server error');
  }
});

app.post('/private-groups/create', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 60) {
      return res.redirect('/private-groups?error=Group%20name%20must%20be%202%20to%2060%20characters');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await PrivateGroup.create({
          name,
          code: makePrivateGroupCode(),
          ownerId: req.session.userId,
          members: [req.session.userId]
        });
        return res.redirect('/private-groups');
      } catch (error) {
        if (error.code !== 11000 || attempt === 4) throw error;
      }
    }
  } catch (error) {
    console.error('Private group creation error:', error);
    res.redirect('/private-groups?error=Unable%20to%20create%20group');
  }
});

app.post('/private-groups/join', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      return res.redirect('/private-groups?error=Enter%20a%20valid%208-character%20group%20code');
    }

    const group = await PrivateGroup.findOneAndUpdate(
      {
        code,
        members: { $ne: req.session.userId },
        $expr: { $lt: [{ $size: '$members' }, 10] }
      },
      { $addToSet: { members: req.session.userId } },
      { new: true }
    );
    if (!group) {
      return res.redirect('/private-groups?error=Group%20not%20found%2C%20full%2C%20or%20you%20already%20joined');
    }
    res.redirect(`/private-groups/${group._id}`);
  } catch (error) {
    console.error('Private group join error:', error);
    res.redirect('/private-groups?error=Unable%20to%20join%20group');
  }
});

app.get('/private-groups/:groupId', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId).lean();
    if (!group || !group.members.some(memberId => String(memberId) === String(req.session.userId))) {
      return res.status(404).send('Private group not found');
    }
    const [user, stats] = await Promise.all([
      User.findById(req.session.userId),
      buildPrivateGroupStats(group)
    ]);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);
    res.render('private-group', {
      user,
      group,
      stats,
      isOwner: String(group.ownerId) === String(req.session.userId),
      queryError: req.query.error || null
    });
  } catch (error) {
    console.error('Private group detail error:', error);
    res.status(500).send('Server error');
  }
});

app.post('/private-groups/:groupId/leave', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId);
    if (!group) return res.redirect('/private-groups');
    if (String(group.ownerId) === String(req.session.userId)) {
      return res.redirect(`/private-groups/${group._id}?error=Owners%20cannot%20leave%20their%20group`);
    }
    await PrivateGroup.updateOne(
      { _id: group._id, members: req.session.userId },
      { $pull: { members: req.session.userId } }
    );
    res.redirect('/private-groups');
  } catch (error) {
    console.error('Private group leave error:', error);
    res.redirect('/private-groups?error=Unable%20to%20leave%20group');
  }
});

app.post('/private-groups/:groupId/remove-member', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId);
    if (!group || String(group.ownerId) !== String(req.session.userId)) {
      return res.status(403).send('Only the group owner can remove members');
    }
    if (String(req.body.memberId) === String(group.ownerId)) {
      return res.redirect(`/private-groups/${group._id}?error=The%20group%20owner%20cannot%20be%20removed`);
    }
    await PrivateGroup.updateOne(
      { _id: group._id },
      { $pull: { members: req.body.memberId } }
    );
    res.redirect(`/private-groups/${group._id}`);
  } catch (error) {
    console.error('Private group member removal error:', error);
    res.redirect(`/private-groups/${req.params.groupId}?error=Unable%20to%20remove%20member`);
  }
});

app.post('/private-groups/:groupId/delete', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const deletedGroup = await PrivateGroup.findOneAndDelete({
      _id: req.params.groupId,
      ownerId: req.session.userId
    });
    if (!deletedGroup) return res.status(403).send('Only the group owner can delete this group');
    res.redirect('/private-groups');
  } catch (error) {
    console.error('Private group deletion error:', error);
    res.redirect(`/private-groups/${req.params.groupId}?error=Unable%20to%20delete%20group`);
  }
});

app.get('/profile/:username', noCache, async (req, res) => {
  try {
    await dbConnect();
    const username = normalizeUsername(req.params.username);
    const profile = await User.findOne({ username })
      .select('name username publicProfile timeUnit totalFocusMinutes averageWeeklyFocusMinutes averageMonthlyFocusMinutes createdAt')
      .lean();
    if (!profile) return res.status(404).render('public-profile', { profile: null, isPrivate: false });
    if (!profile.publicProfile) return res.render('public-profile', { profile: null, isPrivate: true });
    res.render('public-profile', { profile, isPrivate: false });
  } catch (error) {
    console.error('Public profile page error:', error);
    res.status(500).send('Server error');
  }
});

app.get('/profile', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const heatmapStart = new Date(todayUTC);
    heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
    heatmapStart.setUTCDate(heatmapStart.getUTCDate() - ((heatmapStart.getUTCDay() + 6) % 7));
    const heatmapEnd = new Date(heatmapStart);
    heatmapEnd.setUTCDate(heatmapEnd.getUTCDate() + 53 * 7);
    const [user, logs, achievements, focusSessions] = await Promise.all([
      User.findById(req.session.userId),
      StudyLog.find({ userId: req.session.userId }),
      Achievement.find({ userId: req.session.userId }),
      FocusSession.find({ userId: req.session.userId, status: 'completed', startTime: { $gte: heatmapStart, $lt: heatmapEnd } }).select('startTime durationSeconds').lean()
    ]);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);
    const focusStats = await syncFocusStats(user._id, logs);
    Object.assign(user, focusStats);
    const xpData = await calculateXpAndLevel(user._id, user, logs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;
    const heatmapLogs = buildCalendarLogs(logs.filter(log => log.date >= heatmapStart && log.date < heatmapEnd), focusSessions);
    res.render('profile', {
      user,
      heatmapLogs,
      heatmapStart,
      success: req.query.profileSuccess || null,
      error: req.query.profileError || null
    });
  } catch (error) {
    console.error('Profile page error:', error);
    res.status(500).send('Server error');
  }
});

app.get('/api/profiles/:username', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const username = normalizeUsername(req.params.username);
    const user = await User.findOne({ username, publicProfile: true }).select('_id username');
    if (!user) return res.status(404).json({ error: 'Public profile not found' });
    const totals = await FocusSession.aggregate([
      { $match: { userId: user._id, status: 'completed' } },
      { $group: { _id: null, totalSeconds: { $sum: '$durationSeconds' } } }
    ]);
    res.json({ username: user.username, totalSeconds: totals[0]?.totalSeconds || 0 });
  } catch (error) {
    console.error('Public profile API error:', error);
    res.status(500).json({ error: 'Unable to load public profile' });
  }
});

app.get('/settings', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const user = await User.findById(req.session.userId);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);
    const success = req.query.profileSuccess || (req.query.success === 'true' ? 'Goal updated successfully' : null);
    const error = req.query.profileError || null;
    res.render('settings', { user, success, error });
  } catch (error) {
    console.error('Settings page error:', error);
    res.status(500).send('Server error');
  }
});

app.post('/update-profile', authenticateUser, noCache, [
  body('username').optional().trim().toLowerCase().matches(/^[a-z0-9_]{3,30}$/),
  body('publicProfile').isBoolean(),
  body('publicProfileEnabled').optional().isBoolean()
], async (req, res) => {
  try {
    await dbConnect();
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).send('User not found');
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.redirect('/settings?profileError=Invalid%20profile%20details');
    const submittedUsername = normalizeUsername(req.body.username);
    if (submittedUsername && submittedUsername !== user.username) {
      return res.redirect('/settings?profileError=Username%20cannot%20be%20changed%20after%20signup');
    }
    const publicProfile = req.body.publicProfileEnabled === true
      || req.body.publicProfileEnabled === 'true'
      || req.body.publicProfileEnabled === 'on';
    const updatedUser = await User.findByIdAndUpdate(
      req.session.userId,
      { $set: { publicProfile } },
      { new: true, runValidators: false }
    ).select('publicProfile');
    if (!updatedUser || updatedUser.publicProfile !== publicProfile) {
      return res.redirect('/settings?profileError=Unable%20to%20save%20profile%20visibility');
    }
    const visibilityMessage = publicProfile
      ? 'Your profile is now public.'
      : 'Your profile is now private.';
    res.redirect(`/settings?profileSuccess=${encodeURIComponent(visibilityMessage)}`);
  } catch (error) {
    console.error('Profile update error:', error);
    res.redirect('/settings?profileError=Unable%20to%20update%20profile');
  }
});

app.post('/clear-account-data', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;
    await Promise.all([
      StudyLog.deleteMany({ userId }),
      FocusSession.deleteMany({ userId }),
      Achievement.deleteMany({ userId })
    ]);
    const user = await User.findById(req.session.userId);
    if (!user) {
      return req.session.destroy(() => {
        res.redirect('/login');
      });
    }
    res.redirect('/settings?profileSuccess=All%20study%20data%20and%20achievements%20have%20been%20cleared');
  } catch (error) {
    console.error(error);
    res.redirect('/settings?profileError=Error%20clearing%20data');
  }
});

app.post('/update-password', authenticateUser, noCache, [
  body('newPassword').isLength({ min: 6 }),
  body('confirmNewPassword').custom((value, { req }) => {
    if (value !== req.body.newPassword) {
      throw new Error('Passwords do not match');
    }
    return true;
  })
], async (req, res) => {
  await dbConnect();
  const user = await User.findById(req.session.userId);
  if (!user) {
    return req.session.destroy(() => { res.redirect('/login'); });
  }

  const [allLogs, achievements] = await Promise.all([
    StudyLog.find({ userId: req.session.userId }),
    Achievement.find({ userId: req.session.userId, achieved: true })
  ]);

  const xpData = await calculateXpAndLevel(req.session.userId, user, allLogs, achievements);
  user.xp = xpData.xp;
  user.level = xpData.level;

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.redirect('/settings?profileError=New%20passwords%20do%20not%20match');
  }
  try {
    const { currentPassword, newPassword } = req.body;
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.redirect('/settings?profileError=Incorrect%20current%20password');
    }
    user.password = newPassword;
    await user.save();
    res.redirect('/settings?profileSuccess=Password%20updated%20successfully');
  } catch (error) {
    console.error(error);
    res.redirect('/settings?profileError=Error%20updating%20password');
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;