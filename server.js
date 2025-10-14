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

const User = require('./models/User');
const StudyLog = require('./models/StudyLog');
const Achievement = require('./models/Achievement');
const { authenticateUser } = require('./middleware/auth');
const { achievementsList, router: achievementRouter } = require('./routes/achievements');

const app = express();

// --- Database Connection & Middleware ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB connection error:', err));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 10 * 24 * 60 * 60 * 1000, httpOnly: true }
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

app.use('/api/achievements', achievementRouter);

// --- DYNAMIC XP & Leveling Logic ---
const XP_PER_HOUR = 10;
const XP_FOR_GOAL = 50;
const XP_FOR_ACHIEVEMENT = 100;
const XP_PER_LEVEL = 1000; // New constant for level calculation

const calculateXpAndLevel = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return { xp: 0, level: 1 };

    // 1. Calculate XP from study hours and goals met
    const allLogs = await StudyLog.find({ userId });
    let xpFromLogs = 0;
    allLogs.forEach(log => {
        xpFromLogs += log.hours * XP_PER_HOUR;
        if (log.hours >= user.dailyGoalHours) {
            xpFromLogs += XP_FOR_GOAL;
        }
    });

    // 2. Calculate XP from achievements
    const achievements = await Achievement.find({ userId, achieved: true });
    const xpFromAchievements = achievements.length * XP_FOR_ACHIEVEMENT;

    const totalXp = Math.round(xpFromLogs + xpFromAchievements);
    
    // Updated level calculation
    const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;

    return { xp: totalXp, level: Math.min(level, 100) }; // Cap level at 100
};


// --- Core Routes ---

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await user.comparePassword(password))) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  req.session.userId = user._id;
  req.session.save((err) => {
    if (err) {
      console.error(err);
      return res.render('login', { error: 'Server error occurred' });
    }
    res.redirect('/dashboard');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null, errors: [] });
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

const calculateLongestStreak = (logs) => {
    if (!logs || logs.length === 0) return 0;
    if (logs.length === 1) return 1;
    let maxStreak = 0;
    let currentStreak = 1;
    for (let i = 1; i < logs.length; i++) {
        const prevDate = logs[i - 1].date;
        const currentDate = logs[i].date;
        const diffInDays = (currentDate.getTime() - prevDate.getTime()) / (1000 * 3600 * 24);
        if (diffInDays === 1) {
            currentStreak++;
        } else if (diffInDays > 1) {
            maxStreak = Math.max(maxStreak, currentStreak);
            currentStreak = 1;
        }
    }
    return Math.max(maxStreak, currentStreak);
};

const calculateCurrentStreak = (logs) => {
    if (!logs || logs.length === 0) return 0;

    let currentStreak = 0;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const logDates = new Set(logs.map(log => log.date.getTime()));

    let currentDate = yesterday;
    while (logDates.has(currentDate.getTime())) {
        currentStreak++;
        currentDate.setDate(currentDate.getDate() - 1);
    }

    return currentStreak;
};


app.get('/dashboard', authenticateUser, noCache, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
        return req.session.destroy(() => {
          res.redirect('/login');
        });
    }

    // Dynamically calculate XP and Level
    const { xp, level } = await calculateXpAndLevel(req.session.userId);
    user.xp = xp;
    user.level = level;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayLog = await StudyLog.findOne({ userId: req.session.userId, date: today });

    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentLogs = await StudyLog.find({
      userId: req.session.userId,
      date: { $gte: thirtyDaysAgo }
    }).sort({ date: -1 });
    
    const allLogs = await StudyLog.find({ userId: req.session.userId }).sort({ date: 'asc' });

    const consistencyLogs = allLogs.filter(log => log.hours > 0);
    const goalLogs = allLogs.filter(log => log.hours >= user.dailyGoalHours);

    const currentConsistencyStreak = calculateCurrentStreak(consistencyLogs);
    const currentGoalStreak = calculateCurrentStreak(goalLogs);
    const maxConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const maxGoalStreak = calculateLongestStreak(goalLogs);

    const { totalHoursRange = 'alltime' } = req.query;
    const totalHoursMatch = { userId: user._id };
    let startDate = null;
    const now = new Date();
    switch (totalHoursRange) {
      case '7days':
        startDate = new Date(new Date().setDate(now.getDate() - 7));
        break;
      case '1month':
        startDate = new Date(new Date().setMonth(now.getMonth() - 1));
        break;
      case '6months':
        startDate = new Date(new Date().setMonth(now.getMonth() - 6));
        break;
    }
    if (startDate) {
      totalHoursMatch.date = { $gte: startDate };
    }
    const totalHoursAgg = await StudyLog.aggregate([
      { $match: totalHoursMatch },
      { $group: { _id: null, total: { $sum: '$hours' } } }
    ]);
    
    const achievementCount = await Achievement.countDocuments({ userId: req.session.userId, notified: false });

    res.render('dashboard', {
      user,
      todayHours: todayLog ? todayLog.hours : 0,
      recentLogs,
      totalHours: totalHoursAgg.length > 0 ? totalHoursAgg[0].total : 0,
      totalHoursRange: totalHoursRange,
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
    const userId = req.session.userId;
    const user = await User.findById(userId);

    const achievements = await Achievement.find({ userId, achieved: true }).sort({ dateAchieved: 'desc' });
    const studyLogs = await StudyLog.find({ userId }).sort({ date: 'desc' });

    const achievementHistory = achievements.map(ach => {
      return `+${XP_FOR_ACHIEVEMENT} XP: Achievement unlocked - "${ach.name}"`;
    });

    const logHistory = [];
    studyLogs.forEach(log => {
      logHistory.push(`+${log.hours * XP_PER_HOUR} XP: Studied for ${log.hours} hours on ${log.date.toLocaleDateString()}`);
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


// --- Dynamic Achievement Logic & Other Routes ---

app.get('/calendar', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);

      // Dynamically calculate XP and Level for display
      const { xp, level } = await calculateXpAndLevel(req.session.userId);
      user.xp = xp;
      user.level = level;

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

      const logs = await StudyLog.find({
        userId: req.session.userId,
        date: { $gte: currentMonth, $lt: nextMonth }
      });

      res.render('calendar', { user, logs, currentMonth, error: null });
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});
  
const reevaluateAchievements = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return;
    const allLogs = await StudyLog.find({ userId }).sort({ date: 'asc' });
    const userAchievements = await Achievement.find({ userId });
    const achievedIds = new Set(userAchievements.map(a => a.achievementId));

    for (const achievement of achievementsList) {
        const isAchievedInDB = achievedIds.has(achievement.id);
        const userQualifies = achievement.check(allLogs, user);

        if (userQualifies && !isAchievedInDB) {
            await Achievement.findOneAndUpdate(
                { userId, achievementId: achievement.id },
                {
                    name: achievement.name,
                    description: achievement.description,
                    achieved: true,
                    dateAchieved: new Date(),
                    notified: false,
                    goalValueOnAchieved: achievement.type === 'goal' ? user.dailyGoalHours : undefined,
                },
                { upsert: true, new: true }
            );
        } else if (!userQualifies && isAchievedInDB) {
            await Achievement.deleteOne({ userId, achievementId: achievement.id });
        }
    }
};

app.post('/add-study-log', authenticateUser, noCache, [
  body('date').isISO8601(),
  body('hours').isFloat({ min: 0, max: 24 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).send('Invalid data provided');
    }
    try {
      const { date, hours } = req.body;
      const [year, month, day] = date.split('-').map(Number);
      const logDate = new Date(Date.UTC(year, month - 1, day));
      
      await StudyLog.findOneAndUpdate(
        { userId: req.session.userId, date: logDate },
        { hours: parseFloat(hours) },
        { upsert: true, new: true }
      );
      await reevaluateAchievements(req.session.userId);
      res.redirect('/calendar');
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});

app.post('/update-goal', authenticateUser, noCache, [
  body('dailyGoalHours').isFloat({ min: 0.5, max: 24 })
], async (req, res) => {
    const user = await User.findById(req.session.userId);
    // Re-calculate XP for rendering the settings page with an error if validation fails
    const { xp, level } = await calculateXpAndLevel(req.session.userId);
    user.xp = xp;
    user.level = level;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', { user, success: null, error: 'Invalid goal value' });
    }
    try {
      user.dailyGoalHours = parseFloat(req.body.dailyGoalHours);
      await user.save();
      await reevaluateAchievements(req.session.userId);
      res.redirect('/settings?success=true');
    } catch (error) {
      console.error(error);
      res.render('settings', { user, success: null, error: 'Error updating goal' });
    }
});

app.get('/achievements', authenticateUser, noCache, async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await User.findById(userId);

    // Dynamically calculate XP and Level for display
    const { xp, level } = await calculateXpAndLevel(userId);
    user.xp = xp;
    user.level = level;

    const allLogs = await StudyLog.find({ userId }).sort({ date: 'asc' });
    const consistencyLogs = allLogs.filter(log => log.hours > 0);
    const goalLogs = allLogs.filter(log => log.hours >= user.dailyGoalHours);
    const longestConsistencyStreak = calculateLongestStreak(consistencyLogs);
    const longestGoalStreak = calculateLongestStreak(goalLogs);
    const achievedDocs = await Achievement.find({ userId });
    const achievedIds = new Set(achievedDocs.map(a => a.achievementId));
    const allAchievements = achievementsList.map(ach => {
      const isAchieved = achievedIds.has(ach.id);
      const doc = isAchieved ? achievedDocs.find(d => d.achievementId === ach.id) : null;
      return {
        ...ach,
        achieved: isAchieved,
        goalValueOnAchieved: doc ? doc.goalValueOnAchieved : null,
      };
    });
    const completed = allAchievements.filter(a => a.achieved);
    const yetToCompleteConsistency = allAchievements.filter(a => !a.achieved && a.type === 'consistency');
    const yetToCompleteGoal = allAchievements.filter(a => !a.achieved && a.type === 'goal');
    res.render('achievements', { 
        user,
        completed, 
        yetToCompleteConsistency, 
        yetToCompleteGoal,
        longestConsistencyStreak,
        longestGoalStreak,
        achievementsList
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/analytics', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);

      // Dynamically calculate XP and Level for display
      const { xp, level } = await calculateXpAndLevel(req.session.userId);
      user.xp = xp;
      user.level = level;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const logs = await StudyLog.find({
        userId: req.session.userId,
        date: { $gte: thirtyDaysAgo }
      }).sort({ date: 1 });
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      const weekLogs = await StudyLog.find({
        userId: req.session.userId,
        date: { $gte: sevenDaysAgo }
      });
      const weekAverage = weekLogs.length > 0
        ? weekLogs.reduce((sum, log) => sum + log.hours, 0) / weekLogs.length
        : 0;
      const monthTotal = logs.reduce((sum, log) => sum + log.hours, 0);
      res.render('analytics', {
        user,
        logs,
        weekAverage: weekAverage.toFixed(2),
        monthTotal: monthTotal.toFixed(2)
      });
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});

app.get('/api/analytics', authenticateUser, noCache, async (req, res) => {
  try {
      const userId = req.session.userId;
      const { chart, startDate, endDate, month } = req.query;
      let data;

      switch (chart) {
          case 'dateRange':
              data = await StudyLog.find({
                  userId,
                  date: { $gte: new Date(startDate), $lte: new Date(endDate) }
              }).sort({ date: 'asc' });
              break;
          case 'monthly':
              const [year, monthNum] = month.split('-').map(Number);
              const firstDay = new Date(Date.UTC(year, monthNum - 1, 1));
              const lastDay = new Date(Date.UTC(year, monthNum, 0));
              data = await StudyLog.find({
                  userId,
                  date: { $gte: firstDay, $lte: lastDay }
              }).sort({ date: 'asc' });
              break;
          case 'dayOfWeek':
               const [yearD, monthNumD] = month.split('-').map(Number);
               const firstDayD = new Date(Date.UTC(yearD, monthNumD - 1, 1));
               const lastDayD = new Date(Date.UTC(yearD, monthNumD, 0));
              data = await StudyLog.aggregate([
                  { $match: { userId: new mongoose.Types.ObjectId(userId), date: { $gte: firstDayD, $lte: lastDayD } } },
                  { $group: { _id: { $dayOfWeek: "$date" }, avgHours: { $avg: "$hours" } } },
                   { $sort: { _id: 1 } }
              ]);
              break;
          case 'goalAchievement':
               const [yearG, monthNumG] = month.split('-').map(Number);
               const firstDayG = new Date(Date.UTC(yearG, monthNumG - 1, 1));
               const lastDayG = new Date(Date.UTC(yearG, monthNumG, 0));
              const user = await User.findById(userId);
              const logs = await StudyLog.find({ userId, date: { $gte: firstDayG, $lte: lastDayG } });
              const met = logs.filter(log => log.hours >= user.dailyGoalHours).length;
              const notMet = logs.length - met;
              data = { met, notMet };
              break;
          default:
              return res.status(400).json({ error: 'Invalid chart type' });
      }
      res.json(data);
  } catch (error) {
      console.error('Analytics API error:', error);
      res.status(500).json({ error: 'Server error' });
  }
});
  
app.get('/settings', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);
      const { xp, level } = await calculateXpAndLevel(req.session.userId);
      user.xp = xp;
      user.level = level;
      const success = req.query.success === 'true' ? 'Goal updated successfully' : null;
      res.render('settings', { user, success, error: null});
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});

app.post('/clear-account-data', authenticateUser, noCache, async (req, res) => {
  try {
    const userId = req.session.userId;
    await StudyLog.deleteMany({ userId });
    await Achievement.deleteMany({ userId });
    
    const user = await User.findById(req.session.userId);
    // Recalculate XP (which will be 0) to render the page
    const { xp, level } = await calculateXpAndLevel(req.session.userId);
    user.xp = xp;
    user.level = level;

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
  const user = await User.findById(req.session.userId);
  const { xp, level } = await calculateXpAndLevel(req.session.userId);
  user.xp = xp;
  user.level = level;

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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;