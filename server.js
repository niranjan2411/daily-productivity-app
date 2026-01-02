require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const dbConnect = require('./lib/dbConnect');
// Trigger the main app DB connection immediately to warm up the server
dbConnect().catch(err => console.error("Main DB Connection Error:", err));

const User = require('./models/User');
const StudyLog = require('./models/StudyLog');
const Achievement = require('./models/Achievement');
const { authenticateUser } = require('./middleware/auth');
const { achievementsList, router: achievementRouter } = require('./routes/achievements');

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

// XP Logic
const XP_PER_HOUR = 10;
const XP_FOR_GOAL = 50;
const XP_FOR_ACHIEVEMENT = 100;
const XP_PER_LEVEL = 1000;

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
        xpFromLogs += log.hours * XP_PER_HOUR;
        if (log.hours >= user.dailyGoalHours) {
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
        goalValueOnAchieved: achievement.type === 'goal' ? user.dailyGoalHours : undefined,
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

app.post('/signup', authLimiter, [
  body('name').trim().escape(),
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
    const { name, email, password } = req.body;
    if (await User.findOne({ email })) {
      return res.render('signup', { error: 'Email already registered', errors: [] });
    }
    const user = new User({ name, email, password });
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

    const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const todayLog = allLogs.find(log => log.date.getTime() === todayUTC.getTime());
    const todayHours = todayLog ? todayLog.hours : 0;

    const thirtyDaysAgo = new Date(todayUTC);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const recentLogs = allLogs
      .filter(log => log.date >= thirtyDaysAgo)
      .sort((a, b) => b.date - a.date);

    const { totalHoursRange = 'alltime' } = req.query;
    let totalHours = 0;

    if (totalHoursRange === 'alltime') {
      totalHours = allLogs.reduce((acc, log) => acc + log.hours, 0);
    } else {
      let startDate = null;
      if (totalHoursRange === '7days') {
        startDate = new Date(todayUTC);
        startDate.setUTCDate(startDate.getUTCDate() - 7);
      } else if (totalHoursRange === '1month') {
        startDate = new Date(todayUTC);
        startDate.setUTCMonth(startDate.getUTCMonth() - 1);
      } else if (totalHoursRange === '6months') {
        startDate = new Date(todayUTC);
        startDate.setUTCMonth(startDate.getUTCMonth() - 6);
      }

      if (startDate) {
        totalHours = allLogs
          .filter(log => log.date >= startDate)
          .reduce((acc, log) => acc + log.hours, 0);
      }
    }

    const achievementCount = achievements.filter(a => a.achieved && !a.notified).length;

    const consistencyLogs = allLogs.filter(log => log.hours > 0);
    const goalLogs = allLogs.filter(log => log.hours >= user.dailyGoalHours);
    const currentConsistencyStreak = calculateCurrentStreak(consistencyLogs);
    const currentGoalStreak = calculateCurrentStreak(goalLogs);
    const maxConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const maxGoalStreak = calculateLongestStreak(goalLogs);

    res.render('dashboard', {
      user,
      todayHours,
      recentLogs,
      totalHours,
      totalHoursRange,
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
      logHistory.push(`+${Math.round(log.hours * XP_PER_HOUR)} XP: Studied for ${log.hours} hours on ${log.date.toLocaleDateString()}`);
      if (log.hours >= user.dailyGoalHours) {
        logHistory.push(`+${XP_FOR_GOAL} XP: Daily goal met on ${log.date.toLocaleDateString()}`);
      }
    });
    res.json({ achievements: achievementHistory, logs: logHistory });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error fetching XP history' });
  }
});

app.get('/calendar', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievements] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }),
      Achievement.find({ userId, achieved: true })
    ]);

    if (!user) {
      return req.session.destroy(() => { res.redirect('/login'); });
    }

    const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;

    let currentMonth;
    if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      currentMonth = new Date(Date.UTC(year, month - 1, 1));
    } else {
      currentMonth = new Date();
      currentMonth.setUTCDate(1);
    }
    currentMonth.setUTCHours(0, 0, 0, 0);

    const nextMonth = new Date(currentMonth);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

    const monthLogs = allLogs.filter(log =>
      log.date >= currentMonth && log.date < nextMonth
    );

    const isPartial = req.query.partial === 'true';

    res.render('calendar', {
      user,
      logs: monthLogs,
      currentMonth,
      error: null,
      partial: isPartial
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/add-study-log', authenticateUser, noCache, [
  body('date').isISO8601(),
  body('hours').isFloat({ min: 0, max: 24 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).send('Invalid data provided');
  }
  try {
    await dbConnect();
    const { date, hours } = req.body;
    const [year, month, day] = date.split('-').map(Number);
    const logDate = new Date(Date.UTC(year, month - 1, day));

    await StudyLog.findOneAndUpdate(
      { userId: req.session.userId, date: logDate },
      { hours: parseFloat(hours) },
      { upsert: true, new: true }
    );

    await reevaluateAchievements(req.session.userId);

    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(200).json({ success: true });
    }

    res.redirect('/calendar');
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/update-goal', authenticateUser, noCache, [
  body('dailyGoalHours').isFloat({ min: 0.5, max: 24 })
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
    return res.render('settings', { user, success: null, error: 'Invalid goal value' });
  }

  try {
    user.dailyGoalHours = parseFloat(req.body.dailyGoalHours);
    await user.save();

    await reevaluateAchievements(userId, user, allLogs, achievements);

    res.redirect('/settings?success=true');
  } catch (error) {
    console.error(error);
    res.render('settings', { user, success: null, error: 'Error updating goal' });
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

    const consistencyLogs = allLogs.filter(log => log.hours > 0);
    const goalLogs = allLogs.filter(log => log.hours >= user.dailyGoalHours);

    const longestConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const longestGoalStreak = calculateLongestStreak(goalLogs);
    const totalStudyHours = allLogs.reduce((acc, log) => acc + log.hours, 0);

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
      totalStudyHours,
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

    const currentMonthLogs = allLogs.filter(log => log.date >= startOfMonth && log.date < nextMonth);
    const currentMonthTotal = currentMonthLogs.reduce((sum, log) => sum + log.hours, 0);
    const currentMonthDaysLogged = currentMonthLogs.length;
    const currentMonthAvg = currentMonthDaysLogged > 0 ? currentMonthTotal / currentMonthDaysLogged : 0;

    res.render('analytics', {
      user,
      logs: recentLogs,
      currentMonthTotal: currentMonthTotal.toFixed(2),
      currentMonthAvg: currentMonthAvg.toFixed(2)
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
          { $group: { _id: { $dayOfWeek: "$date" }, avgHours: { $avg: "$hours" } } },
          { $sort: { _id: 1 } }
        ]);
        break;
      case 'goalAchievement':
        const [yearG, monthNumG] = month.split('-').map(Number);
        const firstDayG = new Date(Date.UTC(yearG, monthNumG - 1, 1));
        const lastDayG = new Date(Date.UTC(yearG, monthNumG, 0));
        const userGoal = await User.findById(userId);
        const logs = await StudyLog.find({ userId, date: { $gte: firstDayG, $lte: lastDayG } });
        const met = logs.filter(log => log.hours >= userGoal.dailyGoalHours).length;
        const notMet = logs.length - met;
        data = { met, notMet };
        break;

      case 'distribution':
        const userDist = await User.findById(req.session.userId);
        if (!userDist) return res.status(401).json({ error: 'User not found' });

        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        let matchQuery = { userId: userDist._id };
        let label = 'Total Hours';
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

        const aggResult = await StudyLog.aggregate([
          { $match: matchQuery },
          { $group: { _id: null, total: { $sum: '$hours' }, count: { $sum: 1 } } }
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
              total: { $sum: "$hours" }
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

app.get('/settings', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;

    const [user, allLogs, achievements] = await Promise.all([
      User.findById(userId),
      StudyLog.find({ userId }),
      Achievement.find({ userId, achieved: true })
    ]);

    if (!user) {
      return req.session.destroy(() => { res.redirect('/login'); });
    }

    const xpData = await calculateXpAndLevel(userId, user, allLogs, achievements);
    user.xp = xpData.xp;
    user.level = xpData.level;

    const success = req.query.success === 'true' ? 'Goal updated successfully' : null;
    res.render('settings', { user, success, error: null });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/clear-account-data', authenticateUser, noCache, async (req, res) => {
  try {
    await dbConnect();
    const userId = req.session.userId;
    await Promise.all([
      StudyLog.deleteMany({ userId }),
      Achievement.deleteMany({ userId })
    ]);
    const user = await User.findById(req.session.userId);
    if (!user) {
      return req.session.destroy(() => {
        res.redirect('/login');
      });
    }
    res.render('settings', { user, success: 'All study data and achievements have been cleared', error: null });
  } catch (error) {
    console.error(error);
    const user = await User.findById(req.session.userId);
    res.render('settings', { user, success: null, error: 'Error clearing data' });
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
    return res.render('settings', { user, success: null, error: 'New passwords do not match' });
  }
  try {
    const { currentPassword, newPassword } = req.body;
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.render('settings', { user, success: null, error: 'Incorrect current password' });
    }
    user.password = newPassword;
    await user.save();
    res.render('settings', { user, success: 'Password updated successfully', error: null });
  } catch (error) {
    console.error(error);
    res.render('settings', { user, success: null, error: 'Error updating password' });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;