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
const PlatformVisit = require('./models/PlatformVisit');
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

const isLikelyBot = (userAgent = '') => /bot|crawler|spider|slurp|preview|bingpreview|duckduckbot|headless|curl|wget/i.test(userAgent);

app.use((req, res, next) => {
  const userAgent = String(req.get('User-Agent') || '');
  if (!req.session || !req.session.userId || isLikelyBot(userAgent)) {
    return next();
  }

  const visitDate = new Date();
  visitDate.setUTCHours(0, 0, 0, 0);

  dbConnect()
    .then(() => PlatformVisit.updateOne(
      { userId: req.session.userId, visitDate },
      {
        $set: { lastSeenAt: new Date() },
        $setOnInsert: { userId: req.session.userId, visitDate }
      },
      { upsert: true }
    ))
    .catch((error) => {
      console.error('Visit tracking error:', error);
    })
    .finally(() => next());
});

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
const XP_PER_MINUTE = 1;
const XP_FOR_GOAL = 50;
const XP_FOR_ACHIEVEMENT = 100;
const XP_PER_LEVEL = 2000;
const MAX_DAILY_MINUTES = 23 * 60 + 59;

const clampDailyMinutes = (minutes) => {
  const safeMinutes = Number(minutes) || 0;
  if (!Number.isFinite(safeMinutes)) return 0;
  return Math.min(Math.max(safeMinutes, 0), MAX_DAILY_MINUTES);
};

const getLogMinutes = (log) => {
  const minutes = Number(log.minutes);
  const hours = Number(log.hours);
  const normalizedMinutes = Number.isFinite(hours) && hours > 0 && (!Number.isFinite(minutes) || minutes <= 0)
    ? Math.round(hours * 60 * 100) / 100
    : (Number.isFinite(minutes) ? minutes : 0);
  return clampDailyMinutes(normalizedMinutes);
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

const formatRoundedMetric = (value, minimumDisplay = 10) => {
  const rawValue = Number(value) || 0;
  if (rawValue <= 0) return `${minimumDisplay}+`;
  if (rawValue >= 1000) return '1K+';
  if (rawValue >= 500) return '500+';
  if (rawValue >= 100) return '100+';
  if (rawValue >= 50) return '50+';
  if (rawValue >= 10) return '10+';
  return `${Math.max(1, Math.floor(rawValue))}+`;
};

const getCommunityStats = async () => {
  await dbConnect();

  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  startDate.setUTCHours(0, 0, 0, 0);

  const [totalUsers, weeklyVisitorIds, totalFocusSessions] = await Promise.all([
    User.countDocuments({}),
    PlatformVisit.distinct('userId', {
      visitDate: { $gte: startDate, $lte: endDate }
    }),
    FocusSession.countDocuments({ status: 'completed' })
  ]);

  return {
    usersJoined: totalUsers,
    usersJoinedLabel: formatRoundedMetric(totalUsers),
    visitorsThisWeek: weeklyVisitorIds.length,
    visitorsThisWeekLabel: formatRoundedMetric(weeklyVisitorIds.length),
    focusSessions: totalFocusSessions,
    focusSessionsLabel: formatRoundedMetric(totalFocusSessions)
  };
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

const normalizeObjectIdList = (values = []) => {
  const seen = new Set();
  return values.reduce((list, value) => {
    if (!value) return list;
    let objectId = value;
    if (!(value instanceof mongoose.Types.ObjectId)) {
      if (!mongoose.Types.ObjectId.isValid(String(value))) return list;
      objectId = new mongoose.Types.ObjectId(String(value));
    }
    const key = String(objectId);
    if (!seen.has(key)) {
      seen.add(key);
      list.push(objectId);
    }
    return list;
  }, []);
};

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

const buildGroupTaskList = (group, currentUserId) => {
  const tasks = (group.tasks || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  return tasks.map(task => {
    const assignedIds = (task.assignedTo || []).map(id => String(id));
    const completedIds = (task.completedBy || []).map(id => String(id));
    const assignedCount = assignedIds.length || (group.members || []).length;
    const completedCount = assignedIds.length
      ? assignedIds.filter(id => completedIds.includes(id)).length
      : 0;

    return {
      _id: task._id,
      title: task.title,
      date: task.date,
      createdBy: task.createdBy ? String(task.createdBy) : null,
      assignedTo: assignedIds,
      completedBy: completedIds,
      assignedCount,
      completedCount,
      isDoneByMe: completedIds.includes(String(currentUserId))
    };
  });
};

const formatMinutesLabel = (minutesValue) => {
  const totalMinutes = Math.max(0, Math.round(Number(minutesValue) || 0));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const getPeriodBoundary = (period, now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  if (period === 'week') {
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else if (period === 'month') {
    start.setUTCDate(1);
  }
  end.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
};

const buildPrivateGroupAnalysis = async (group) => {
  const members = await User.find({ _id: { $in: group.members } })
    .select('name username userId')
    .lean();

  const memberIds = members.map(member => member._id);
  const taskTotal = group.tasks?.length || 0;
  const periods = ['daily', 'weekly', 'monthly'];

  const collectMemberMinutes = (periodKey) => {
    const { start, end } = getPeriodBoundary(periodKey === 'daily' ? 'today' : periodKey === 'weekly' ? 'week' : 'month');
    const stats = new Map(memberIds.map(id => [String(id), 0]));

    const sessions = FocusSession.find({
      userId: { $in: memberIds },
      status: 'completed',
      startTime: { $gte: start, $lt: end }
    }).select('userId durationSeconds startTime').lean();

    const logs = StudyLog.find({
      userId: { $in: memberIds },
      date: { $gte: start, $lt: end }
    }).select('userId date minutes hours').lean();

    return Promise.all([sessions, logs]).then(([sessionRows, logRows]) => {
      sessionRows.forEach(session => {
        const key = String(session.userId);
        if (stats.has(key)) stats.set(key, stats.get(key) + (Number(session.durationSeconds) || 0) / 60);
      });
      logRows.forEach(log => {
        const key = String(log.userId);
        if (stats.has(key)) stats.set(key, stats.get(key) + (Number(log.minutes) || Number(log.hours) * 60 || 0));
      });
      return Array.from(stats.entries()).map(([memberId, minutes]) => ({
        memberId,
        minutes: Number(minutes) || 0
      }));
    });
  };

  const buildTrendData = async (periodKey) => {
    const now = new Date();
    const chartPoints = [];
    if (periodKey === 'daily') {
      for (let offset = 6; offset >= 0; offset -= 1) {
        const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
        const start = new Date(day);
        const end = new Date(day);
        end.setUTCDate(end.getUTCDate() + 1);
        const [sessions, logs] = await Promise.all([
          FocusSession.find({
            userId: { $in: memberIds },
            status: 'completed',
            startTime: { $gte: start, $lt: end }
          }).select('durationSeconds userId').lean(),
          StudyLog.find({
            userId: { $in: memberIds },
            date: { $gte: start, $lt: end }
          }).select('userId minutes hours date').lean()
        ]);
        const value = [...sessions, ...logs].reduce((sum, item) => {
          if ('durationSeconds' in item) return sum + Number(item.durationSeconds || 0) / 60;
          return sum + (Number(item.minutes) || Number(item.hours) * 60 || 0);
        }, 0);
        chartPoints.push({
          label: day.toLocaleDateString('en-US', { weekday: 'short' }),
          value: Math.round(value)
        });
      }
      return chartPoints;
    }

    if (periodKey === 'weekly') {
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const weekRanges = [
        [1, 7],
        [8, 14],
        [15, 21],
        [22, 28],
        [29, lastDay]
      ].filter(([start, end]) => start <= lastDay && end >= start && end >= start);

      for (const [startDay, endDay] of weekRanges) {
        const weekStart = new Date(Date.UTC(year, month, startDay));
        const weekEnd = new Date(Date.UTC(year, month, endDay + 1));
        const [sessions, logs] = await Promise.all([
          FocusSession.find({
            userId: { $in: memberIds },
            status: 'completed',
            startTime: { $gte: weekStart, $lt: weekEnd }
          }).select('durationSeconds userId startTime').lean(),
          StudyLog.find({
            userId: { $in: memberIds },
            date: { $gte: weekStart, $lt: weekEnd }
          }).select('userId date minutes hours').lean()
        ]);
        const value = [...sessions, ...logs].reduce((sum, item) => {
          if ('durationSeconds' in item) return sum + Number(item.durationSeconds || 0) / 60;
          return sum + (Number(item.minutes) || Number(item.hours) * 60 || 0);
        }, 0);
        chartPoints.push({
          label: `${startDay}-${endDay}`,
          value: Math.round(value)
        });
      }
      return chartPoints;
    }

    for (let offset = 5; offset >= 0; offset -= 1) {
      const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const start = new Date(monthDate);
      const end = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1));
      const [sessions, logs] = await Promise.all([
        FocusSession.find({
          userId: { $in: memberIds },
          status: 'completed',
          startTime: { $gte: start, $lt: end }
        }).select('durationSeconds').lean(),
        StudyLog.find({
          userId: { $in: memberIds },
          date: { $gte: start, $lt: end }
        }).select('minutes hours').lean()
      ]);
      const value = [...sessions, ...logs].reduce((sum, item) => {
        if ('durationSeconds' in item) return sum + Number(item.durationSeconds || 0) / 60;
        return sum + (Number(item.minutes) || Number(item.hours) * 60 || 0);
      }, 0);
      chartPoints.push({
        label: monthDate.toLocaleDateString('en-US', { month: 'short' }),
        value: Math.round(value)
      });
    }
    return chartPoints;
  };

  const periodDataMap = {};
  for (const periodKey of periods) {
    const focusValues = await collectMemberMinutes(periodKey);
    const topMinutes = Math.max(...focusValues.map(item => item.minutes), 0);
    const memberRows = members.map(member => {
      const memberId = String(member._id);
      const memberFocus = focusValues.find(item => String(item.memberId) === memberId)?.minutes || 0;
      const completedTasks = (group.tasks || []).filter(task => (task.completedBy || []).some(id => String(id) === memberId)).length;
      const completionRate = taskTotal ? Math.round((completedTasks / taskTotal) * 100) : 0;
      return {
        userId: memberId,
        name: member.name || member.username || 'Member',
        username: member.username || 'focususer',
        initials: (member.name || member.username || '?').charAt(0).toUpperCase(),
        focusMinutes: Math.round(memberFocus),
        focusLabel: formatMinutesLabel(memberFocus),
        completedTasks,
        totalTasks: taskTotal || 0,
        pendingTasks: Math.max(taskTotal - completedTasks, 0),
        completionRate,
        progress: topMinutes ? Math.max(10, Math.round((memberFocus / topMinutes) * 100)) : 0
      };
    }).sort((first, second) => second.focusMinutes - first.focusMinutes || second.completedTasks - first.completedTasks);

    const totalGroupFocus = memberRows.reduce((sum, member) => sum + member.focusMinutes, 0);
    const averageFocus = memberRows.length ? totalGroupFocus / memberRows.length : 0;
    const totalCompletedTasks = memberRows.reduce((sum, member) => sum + member.completedTasks, 0);
    const completionRate = taskTotal && memberRows.length ? Math.round((totalCompletedTasks / (memberRows.length * taskTotal)) * 100) : 0;

    const taskRows = (group.tasks || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map(task => {
      const completedIds = (task.completedBy || []).map(id => String(id));
      const completedCount = completedIds.length;
      const totalGroupMembers = group.members.length || 1;
      const percent = totalGroupMembers ? Math.round((completedCount / totalGroupMembers) * 100) : 0;
      return {
        _id: task._id,
        title: task.title,
        completedCount,
        totalMembers: totalGroupMembers,
        percent,
        completedIds,
        isComplete: completedCount === totalGroupMembers
      };
    });

    const taskProgress = members.map(member => {
      const memberId = String(member._id);
      const completedCount = (group.tasks || []).filter(task => (task.completedBy || []).some(id => String(id) === memberId)).length;
      return {
        userId: memberId,
        name: member.name || member.username || 'Member',
        username: member.username || 'focususer',
        completedCount,
        totalTasks: taskTotal,
        rate: taskTotal ? Math.round((completedCount / taskTotal) * 100) : 0,
        progress: taskTotal ? Math.max(10, Math.round((completedCount / taskTotal) * 100)) : 0
      };
    }).sort((first, second) => second.rate - first.rate || second.completedCount - first.completedCount);

    const trend = await buildTrendData(periodKey);
    const maxTrendValue = Math.max(...trend.map(point => point.value), 1);

    periodDataMap[periodKey] = {
      overview: {
        totalFocusMinutes: totalGroupFocus,
        totalFocusLabel: formatMinutesLabel(totalGroupFocus),
        averageFocusMinutes: Math.round(averageFocus),
        averageFocusLabel: formatMinutesLabel(Math.round(averageFocus)),
        tasksDoneText: `${Math.min(totalCompletedTasks, memberRows.length * Math.max(taskTotal, 0))}/${memberRows.length * Math.max(taskTotal, 0)}`,
        tasksDoneCount: totalCompletedTasks,
        tasksTotal: memberRows.length * Math.max(taskTotal, 0),
        completionRate,
        completionLabel: `${completionRate}%`
      },
      ranking: memberRows,
      taskProgress,
      groupTasks: taskRows,
      memberProgress: memberRows.map(member => ({
        ...member,
        focusLabel: member.focusLabel,
        tasksText: `${member.completedTasks}/${taskTotal || 0}`
      })),
      trend: trend.map(point => ({ ...point, height: Math.max(12, Math.round((point.value / maxTrendValue) * 100)) })),
      memberDetails: memberRows.map(member => ({
        ...member,
        completedTasks: member.completedTasks,
        pendingTasks: member.pendingTasks,
        completionRate: member.completionRate,
        focusAverageByDay: member.focusMinutes ? Math.round(member.focusMinutes / (periodKey === 'daily' ? 1 : periodKey === 'weekly' ? 7 : 30)) : 0,
        focusAverageLabel: formatMinutesLabel(member.focusMinutes ? Math.round(member.focusMinutes / (periodKey === 'daily' ? 1 : periodKey === 'weekly' ? 7 : 30)) : 0)
      }))
    };
  }

  return periodDataMap;
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

const getDailyFocusTotals = async (userId, logsDoc = null) => {
  const studyLogs = logsDoc || await StudyLog.find({ userId }).select('date minutes hours').lean();
  const focusSessions = await FocusSession.find({ userId, status: 'completed' }).select('startTime durationSeconds').lean();
  const dailyTotals = new Map();

  studyLogs.forEach(log => {
    const key = getUTCDateKey(log.date);
    const minutes = getLogMinutes(log);
    dailyTotals.set(key, (dailyTotals.get(key) || 0) + minutes);
  });

  focusSessions.forEach(session => {
    const key = getUTCDateKey(session.startTime);
    const minutes = session.durationSeconds / 60;
    dailyTotals.set(key, (dailyTotals.get(key) || 0) + minutes);
  });

  return dailyTotals;
};

const calculateXpAndLevel = async (userId, userDoc = null, logsDoc = null, achievementsDoc = null) => {
  if (!userDoc || !logsDoc || !achievementsDoc) await dbConnect();

  const user = userDoc || await User.findById(userId);
  if (!user) return { xp: 0, level: 1 };

  let allLogs = logsDoc;
  let achievements = achievementsDoc;

  if (!allLogs || !achievements) {
    const results = await Promise.all([
      !allLogs ? StudyLog.find({ userId }).lean() : null,
      !achievements ? Achievement.find({ userId, achieved: true }).lean() : null
    ]);
    if (!allLogs) allLogs = results[0];
    if (!achievements) achievements = results[1];
  } else {
    achievements = achievements.filter(a => a.achieved !== false);
  }

  const dailyTotals = await getDailyFocusTotals(userId, allLogs);
  let xpFromMinutes = 0;
  let goalBonuses = 0;

  for (const minutes of dailyTotals.values()) {
    const completedMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
    xpFromMinutes += completedMinutes;
    if (minutes >= getGoalMinutes(user)) {
      goalBonuses += XP_FOR_GOAL;
    }
  }

  const xpFromAchievements = achievements ? achievements.length * XP_FOR_ACHIEVEMENT : 0;
  const totalXp = xpFromMinutes * XP_PER_MINUTE + goalBonuses + xpFromAchievements;
  const level = Math.max(1, Math.floor(totalXp / XP_PER_LEVEL) + 1);
  return { xp: totalXp, level };
};

const persistUserXpAndLevel = async (userId, userDoc = null, logsDoc = null, achievementsDoc = null) => {
  const user = userDoc || await User.findById(userId);
  if (!user) return { xp: 0, level: 1 };

  const xpData = await calculateXpAndLevel(userId, user, logsDoc, achievementsDoc);
  const nextLevel = Math.max(1, Number(xpData.level) || 1);
  const nextXp = Math.max(0, Number(xpData.xp) || 0);

  if (user.xp !== nextXp || user.level !== nextLevel) {
    user.xp = nextXp;
    user.level = nextLevel;
    await user.save();
  }

  return { xp: nextXp, level: nextLevel };
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

const buildSignupViewData = (req, override = {}) => ({
  error: override.error || null,
  errors: override.errors || [],
  formData: {
    name: override.formData?.name ?? req.body?.name ?? '',
    username: override.formData?.username ?? req.body?.username ?? '',
    email: override.formData?.email ?? req.body?.email ?? ''
  }
});

const formatSignupValidationError = (errorList = []) => {
  const firstError = errorList[0];
  if (!firstError) return 'Please check the form and try again.';

  const path = firstError.path || firstError.param || '';
  const message = firstError.msg || firstError.message || '';

  if (path === 'password' || message.toLowerCase().includes('password')) {
    return 'Password must be at least 6 characters long.';
  }
  if (path === 'confirmPassword' || message.toLowerCase().includes('match')) {
    return 'Passwords do not match.';
  }
  if (path === 'username' || message.toLowerCase().includes('username')) {
    return 'Username must be 3-30 lowercase letters, numbers, or underscores.';
  }
  if (path === 'email' || message.toLowerCase().includes('email')) {
    return 'Please enter a valid email address.';
  }
  if (path === 'name' || message.toLowerCase().includes('name')) {
    return 'Please enter your full name.';
  }

  return message || 'Invalid data provided';
};

app.get('/signup', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('signup', buildSignupViewData(req));
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
    return res.status(400).render('signup', buildSignupViewData(req, {
      error: formatSignupValidationError(errors.array()),
      errors: errors.array(),
      formData: {
        name: req.body.name || '',
        username: req.body.username || '',
        email: req.body.email || ''
      }
    }));
  }
  try {
    const { name, username, email, password } = req.body;
    if (await User.findOne({ email })) {
      return res.status(400).render('signup', buildSignupViewData(req, {
        error: 'Email already registered',
        errors: [{ path: 'email', msg: 'Email already registered' }],
        formData: { name, username, email }
      }));
    }
    if (await User.findOne({ username: normalizeUsername(username) })) {
      return res.status(400).render('signup', buildSignupViewData(req, {
        error: 'Username is already taken',
        errors: [{ path: 'username', msg: 'Username is already taken' }],
        formData: { name, username, email }
      }));
    }
    const user = new User({ name, username: normalizeUsername(username), email, password });
    await user.save();
    req.session.userId = user._id;
    req.session.save((err) => {
      if (err) {
        console.error(err);
        return res.status(500).render('signup', buildSignupViewData(req, {
          error: 'Server error occurred',
          errors: [],
          formData: { name, username, email }
        }));
      }
      res.redirect('/dashboard');
    });
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
      return res.status(400).render('signup', buildSignupViewData(req, {
        error: 'Username or email is already registered',
        errors: [{ path: 'username', msg: 'Username or email is already registered' }],
        formData: { name: req.body.name || '', username: req.body.username || '', email: req.body.email || '' }
      }));
    }
    res.status(500).render('signup', buildSignupViewData(req, {
      error: 'Server error occurred',
      errors: [],
      formData: { name: req.body.name || '', username: req.body.username || '', email: req.body.email || '' }
    }));
  }
});

app.get('/dashboard', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievements, communityStats] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }).sort({ date: 'asc' }),
      Achievement.find({ userId }),
      getCommunityStats()
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
    await user.save();

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
      maxGoalStreak,
      communityStats
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

    const [achievements, studyLogs, focusSessions] = await Promise.all([
      Achievement.find({ userId, achieved: true }).sort({ dateAchieved: 'desc' }),
      StudyLog.find({ userId }).sort({ date: 'desc' }),
      FocusSession.find({ userId, status: 'completed' }).sort({ startTime: 'desc' })
    ]);

    const achievementHistory = achievements.map(ach => `+${XP_FOR_ACHIEVEMENT} XP: Achievement unlocked - "${ach.name}"`);
    const dailyTotals = new Map();
    studyLogs.forEach(log => {
      const key = getUTCDateKey(log.date);
      dailyTotals.set(key, (dailyTotals.get(key) || 0) + getLogMinutes(log));
    });
    focusSessions.forEach(session => {
      const key = getUTCDateKey(session.startTime);
      dailyTotals.set(key, (dailyTotals.get(key) || 0) + (session.durationSeconds / 60));
    });

    const logHistory = [];
    for (const [dateKey, minutes] of dailyTotals.entries()) {
      const date = new Date(`${dateKey}T00:00:00.000Z`);
      logHistory.push(`+${Math.round(minutes)} XP: Focused for ${Math.round(minutes)} minutes on ${date.toLocaleDateString()}`);
      if (minutes >= getGoalMinutes(user)) {
        logHistory.push(`+${XP_FOR_GOAL} XP: Daily goal met on ${date.toLocaleDateString()}`);
      }
    }
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
    const xpData = await persistUserXpAndLevel(userId);
    res.status(200).json({ success: true, sessionId: savedSession.sessionId, todayMinutes, xp: xpData.xp, level: xpData.level, ...focusStats });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await FocusSession.findOne({ userId: req.session.userId, sessionId: req.body.sessionId });
      if (existing) {
        const [focusStats, todayMinutes] = await Promise.all([
          syncFocusStats(req.session.userId),
          getTodayFocusMinutes(req.session.userId)
        ]);
        const xpData = await persistUserXpAndLevel(req.session.userId);
        return res.status(200).json({ success: true, sessionId: existing.sessionId, todayMinutes, xp: xpData.xp, level: xpData.level, ...focusStats });
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
  body('minutes').isFloat({ min: 0 }),
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
    const inputMinutes = inputUnit === 'hours' ? inputValue * 60 : inputValue;

    if (inputMinutes > MAX_DAILY_MINUTES) {
      return res.status(400).send('Daily study time cannot exceed 23 hours 59 minutes.');
    }

    if (mode === 'reset') {
      await FocusSession.deleteMany({
        userId,
        status: 'completed',
        startTime: { $gte: logDate, $lt: dayEnd }
      });
    }
    const nextManualMinutes = mode === 'add' ? manualMinutes + inputMinutes : inputMinutes;
    if (nextManualMinutes > MAX_DAILY_MINUTES) {
      return res.status(400).send('Daily study time cannot exceed 23 hours 59 minutes.');
    }

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
  body('dailyGoalMinutes').isFloat({ min: 0.1, max: MAX_DAILY_MINUTES }),
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
  await user.save();

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
    await user.save();

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
    await user.save();

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

      case 'monthly_history': {
        const now = new Date();
        const months = [];
        const monthMap = new Map();

        const monthlyRows = await StudyLog.aggregate([
          {
            $match: {
              userId: userObjectId,
              date: {
                $gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)),
                $lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
              }
            }
          },
          {
            $group: {
              _id: { year: { $year: "$date" }, month: { $month: "$date" } },
              total: { $sum: "$minutes" }
            }
          }
        ]);

        for (const row of monthlyRows) {
          monthMap.set(`${row._id.year}-${String(row._id.month).padStart(2, '0')}`, row.total);
        }

        for (let i = 11; i >= 0; i--) {
          const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
          const year = monthDate.getUTCFullYear();
          const month = monthDate.getUTCMonth() + 1;
          const monthKey = `${year}-${String(month).padStart(2, '0')}`;
          const total = monthMap.get(monthKey) || 0;
          const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

          months.push({
            _id: { year, month },
            total,
            average: daysInMonth > 0 ? total / daysInMonth : 0
          });
        }

        data = { months };
        break;
      }

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
    res.json({
      totalParticipants: rankedRows.length,
      currentUserRank: currentRow ? { rank: currentRow.rank, total: rankedRows.length } : null,
      rows
    });
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
    const [user, stats, analysis] = await Promise.all([
      User.findById(req.session.userId),
      buildPrivateGroupStats(group),
      buildPrivateGroupAnalysis(group)
    ]);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    await ensureUserIdentity(user);

    const groupTasks = buildGroupTaskList(group, req.session.userId);

    res.render('private-group', {
      user,
      group,
      stats,
      analysis,
      groupTasks,
      isOwner: String(group.ownerId) === String(req.session.userId),
      queryError: req.query.error || null
    });
  } catch (error) {
    console.error('Private group detail error:', error);
    res.status(500).send('Server error');
  }
});

app.post('/private-groups/:groupId/tasks', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId);
    if (!group || !group.members.some(memberId => String(memberId) === String(req.session.userId))) {
      return res.status(404).json({ success: false, error: 'Private group not found' });
    }

    const title = String(req.body.title || '').trim();
    if (!title) {
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ success: false, error: 'Task title cannot be empty' });
      }
      return res.redirect(`/private-groups/${group._id}?error=Task%20title%20cannot%20be%20empty`);
    }

    group.tasks = group.tasks || [];
    const createdTask = {
      title,
      date: new Date(),
      createdBy: new mongoose.Types.ObjectId(String(req.session.userId)),
      assignedTo: normalizeObjectIdList(group.members),
      completedBy: []
    };
    group.tasks.push(createdTask);
    await group.save();

    const refreshedTasks = buildGroupTaskList(group, req.session.userId);
    const taskPayload = refreshedTasks[refreshedTasks.length - 1] || {
      _id: createdTask._id,
      title,
      assignedCount: group.members.length,
      completedCount: 0,
      isDoneByMe: false
    };

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      const analysis = await buildPrivateGroupAnalysis(group);
      return res.json({
        success: true,
        task: taskPayload,
        groupTasks: refreshedTasks,
        analysis
      });
    }

    res.redirect(`/private-groups/${group._id}`);
  } catch (error) {
    console.error('Private group task create error:', error);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ success: false, error: 'Unable to schedule task' });
    }
    res.redirect(`/private-groups/${req.params.groupId}?error=Unable%20to%20schedule%20task`);
  }
});

app.post('/private-groups/:groupId/tasks/:taskId/toggle', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId);
    if (!group || !group.members.some(memberId => String(memberId) === String(req.session.userId))) {
      return res.status(404).json({ success: false, error: 'Private group not found' });
    }

    const task = group.tasks.id(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const userId = String(req.session.userId);
    const assignedIds = normalizeObjectIdList(task.assignedTo || []).map(id => String(id));
    const hasAccess = assignedIds.length === 0 || assignedIds.includes(userId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Your are not assigned to this task' });
    }

    const normalizedCompleted = normalizeObjectIdList(task.completedBy || []);
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const completedIds = normalizedCompleted.map(id => String(id));
    if (completedIds.includes(userId)) {
      task.completedBy = normalizedCompleted.filter(id => String(id) !== userId);
    } else {
      task.completedBy = normalizeObjectIdList([...normalizedCompleted, userObjectId]);
    }

    await group.save();

    const nextCompletedIds = normalizeObjectIdList(task.completedBy || []).map(id => String(id));
    const nextAssignedIds = normalizeObjectIdList(task.assignedTo || []).map(id => String(id));
    const assignedCount = nextAssignedIds.length || group.members.length;
    const completedCount = nextAssignedIds.length
      ? nextAssignedIds.filter(id => nextCompletedIds.includes(id)).length
      : 0;

    const analysis = await buildPrivateGroupAnalysis(group);
    return res.json({
      success: true,
      isDone: nextCompletedIds.includes(userId),
      taskId: String(task._id),
      taskTitle: task.title,
      assignedCount,
      completedCount,
      groupTasks: buildGroupTaskList(group, userId),
      analysis
    });
  } catch (error) {
    console.error('Private group task toggle error:', error);
    res.status(500).json({ success: false, error: 'Unable to update task' });
  }
});

app.post('/private-groups/:groupId/tasks/:taskId/delete', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const group = await PrivateGroup.findById(req.params.groupId);
    if (!group || !group.members.some(memberId => String(memberId) === String(req.session.userId))) {
      return res.status(404).json({ success: false, error: 'Private group not found' });
    }

    const task = group.tasks.id(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const canDelete = String(task.createdBy) === String(req.session.userId) || String(group.ownerId) === String(req.session.userId);
    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'Only the creator or group owner can delete tasks' });
    }

    group.tasks = (group.tasks || []).filter(item => String(item._id) !== String(req.params.taskId));
    await group.save();

    const analysis = await buildPrivateGroupAnalysis(group);
    return res.json({
      success: true,
      deleted: true,
      groupTasks: buildGroupTaskList(group, req.session.userId),
      analysis
    });
  } catch (error) {
    console.error('Private group task delete error:', error);
    res.status(500).json({ success: false, error: 'Unable to delete task' });
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
      .select('name username publicProfile timeUnit totalFocusMinutes averageWeeklyFocusMinutes averageMonthlyFocusMinutes createdAt xp level')
      .lean();
    if (!profile) return res.status(404).render('public-profile', { profile: null, isPrivate: false, heatmapLogs: [], heatmapStart: null, todayFocusMinutes: 0, yesterdayFocusMinutes: 0, lastWeekFocusMinutes: 0, currentMonthFocusMinutes: 0 });
    if (!profile.publicProfile) return res.render('public-profile', { profile: null, isPrivate: true, heatmapLogs: [], heatmapStart: null, todayFocusMinutes: 0, yesterdayFocusMinutes: 0, lastWeekFocusMinutes: 0, currentMonthFocusMinutes: 0 });

    const userId = profile._id;
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterdayUTC = new Date(todayUTC); yesterdayUTC.setUTCDate(yesterdayUTC.getUTCDate() - 1);
    const lastWeekStart = new Date(todayUTC); lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 6);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const heatmapStart = new Date(todayUTC); heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364); heatmapStart.setUTCDate(heatmapStart.getUTCDate() - ((heatmapStart.getUTCDay() + 6) % 7));
    const heatmapEnd = new Date(heatmapStart); heatmapEnd.setUTCDate(heatmapEnd.getUTCDate() + 53 * 7);

    const [studyLogs, focusSessions] = await Promise.all([
      StudyLog.find({ userId }).sort({ date: 'asc' }).lean(),
      FocusSession.find({ userId, status: 'completed' }).select('startTime durationSeconds').lean()
    ]);

    const getMinutesFromEntry = (entry) => {
      const minutes = Number(entry.minutes);
      const hours = Number(entry.hours);
      if (Number.isFinite(hours) && hours > 0 && (!Number.isFinite(minutes) || minutes <= 0)) return Math.round(hours * 60 * 100) / 100;
      return Number.isFinite(minutes) ? minutes : 0;
    };

    const sumMinutesInRange = (entries, start, end) => {
      let total = 0;
      for (const entry of entries) {
        const date = entry.date || entry.startTime;
        if (!date) continue;
        if (date >= start && date < end) {
          total += entry.durationSeconds ? entry.durationSeconds / 60 : getMinutesFromEntry(entry);
        }
      }
      return total;
    };

    const todayFocusMinutes = sumMinutesInRange(
      [...studyLogs.filter(log => log.date >= todayUTC && log.date < new Date(todayUTC.getTime() + 86400000)), ...focusSessions.filter(session => session.startTime >= todayUTC && session.startTime < new Date(todayUTC.getTime() + 86400000))],
      todayUTC,
      new Date(todayUTC.getTime() + 86400000)
    );
    const yesterdayFocusMinutes = sumMinutesInRange(
      [...studyLogs.filter(log => log.date >= yesterdayUTC && log.date < todayUTC), ...focusSessions.filter(session => session.startTime >= yesterdayUTC && session.startTime < todayUTC)],
      yesterdayUTC,
      todayUTC
    );
    const lastWeekFocusMinutes = sumMinutesInRange(
      [...studyLogs.filter(log => log.date >= lastWeekStart && log.date <= todayUTC), ...focusSessions.filter(session => session.startTime >= lastWeekStart && session.startTime <= todayUTC)],
      lastWeekStart,
      new Date(todayUTC.getTime() + 86400000)
    );
    const currentMonthFocusMinutes = sumMinutesInRange(
      [...studyLogs.filter(log => log.date >= monthStart && log.date <= todayUTC), ...focusSessions.filter(session => session.startTime >= monthStart && session.startTime <= todayUTC)],
      monthStart,
      new Date(todayUTC.getTime() + 86400000)
    );

    const heatmapValues = new Map((studyLogs.filter(log => log.date >= heatmapStart && log.date < heatmapEnd).map(log => [new Date(log.date).toISOString().slice(0, 10), getMinutesFromEntry(log)]) || []));
    for (const session of focusSessions) {
      if (!session.startTime || session.startTime < heatmapStart || session.startTime >= heatmapEnd) continue;
      const key = new Date(session.startTime).toISOString().slice(0, 10);
      heatmapValues.set(key, (heatmapValues.get(key) || 0) + Number(session.durationSeconds || 0) / 60);
    }

    const heatmapLogs = Array.from(heatmapValues.entries()).map(([dateKey, minutes]) => ({
      date: new Date(`${dateKey}T00:00:00.000Z`),
      minutes: Math.round(minutes * 100) / 100
    }));

    const publicProfile = {
      ...profile,
      todayFocusMinutes: Number(todayFocusMinutes) || 0,
      yesterdayFocusMinutes: Number(yesterdayFocusMinutes) || 0,
      lastWeekFocusMinutes: Number(lastWeekFocusMinutes) || 0,
      currentMonthFocusMinutes: Number(currentMonthFocusMinutes) || 0,
      totalFocusMinutes: Number(profile.totalFocusMinutes) || 0
    };

    res.render('public-profile', {
      profile: publicProfile,
      isPrivate: false,
      heatmapLogs,
      heatmapStart,
      todayFocusMinutes: publicProfile.todayFocusMinutes,
      yesterdayFocusMinutes: publicProfile.yesterdayFocusMinutes,
      lastWeekFocusMinutes: publicProfile.lastWeekFocusMinutes,
      currentMonthFocusMinutes: publicProfile.currentMonthFocusMinutes
    });
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
    await user.save();
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
  await user.save();

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