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
const { authenticateUser } = require('./middleware/auth');

const app = express();

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
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGODB_URI 
  }),
  cookie: { 
    maxAge: 10 * 24 * 60 * 60 * 1000,
    httpOnly: true 
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

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
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
    const existingUser = await User.findOne({ email });
    if (existingUser) {
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

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
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

app.get('/dashboard', authenticateUser, noCache, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
        return req.session.destroy(() => {
          res.redirect('/login');
        });
      }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayLog = await StudyLog.findOne({
      userId: req.session.userId,
      date: today
    });
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentLogs = await StudyLog.find({
      userId: req.session.userId,
      date: { $gte: thirtyDaysAgo }
    }).sort({ date: -1 });
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
    res.render('dashboard', {
      user,
      todayHours: todayLog ? todayLog.hours : 0,
      recentLogs,
      totalHours: totalHoursAgg.length > 0 ? totalHoursAgg[0].total : 0,
      totalHoursRange: totalHoursRange
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/calendar', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);
      
      // --- CORRECTED DATE LOGIC ---
      let currentMonth;
      if (req.query.month) {
        // Creates date in UTC to avoid timezone shifts
        const [year, month] = req.query.month.split('-').map(Number);
        currentMonth = new Date(Date.UTC(year, month - 1, 1));
      } else {
        currentMonth = new Date();
        currentMonth.setUTCDate(1); // Set to the first day of the current month
      }
      currentMonth.setUTCHours(0, 0, 0, 0);
      
      const nextMonth = new Date(currentMonth);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      // --- END OF CORRECTION ---

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
  
app.post('/add-study-log', authenticateUser, noCache, [
  body('date').isISO8601().toDate(),
  body('hours').isFloat({ min: 0, max: 24 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).send('Invalid data provided');
    }
    try {
      const { date, hours } = req.body;
      const logDate = new Date(date);
      logDate.setHours(0, 0, 0, 0);
      const existingLog = await StudyLog.findOne({
        userId: req.session.userId,
        date: logDate
      });
      if (existingLog) {
        existingLog.hours = parseFloat(hours);
        await existingLog.save();
      } else {
        const newLog = new StudyLog({
          userId: req.session.userId,
          date: logDate,
          hours: parseFloat(hours),
        });
        await newLog.save();
      }
      res.redirect('/calendar');
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});
  
app.get('/analytics', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);
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
  
app.get('/settings', authenticateUser, noCache, async (req, res) => {
    try {
      const user = await User.findById(req.session.userId);
      res.render('settings', { user, success: null, error: null });
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
});
  
app.post('/update-goal', authenticateUser, noCache, [
  body('dailyGoalHours').isFloat({ min: 0.5, max: 24 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const user = await User.findById(req.session.userId);
      return res.render('settings', { user, success: null, error: 'Invalid goal value' });
    }
    try {
      const { dailyGoalHours } = req.body;
      const user = await User.findById(req.session.userId);
      user.dailyGoalHours = parseFloat(dailyGoalHours);
      await user.save();
      res.render('settings', { user, success: 'Goal updated successfully', error: null });
    } catch (error) {
      console.error(error);
      const user = await User.findById(req.session.userId);
      res.render('settings', { user, success: null, error: 'Error updating goal' });
    }
});

app.post('/clear-account-data', authenticateUser, noCache, async (req, res) => {
  try {
    await StudyLog.deleteMany({ userId: req.session.userId });
    const user = await User.findById(req.session.userId);
    res.render('settings', { user, success: 'All study data has been cleared', error: null });
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
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const user = await User.findById(req.session.userId);
    return res.render('settings', { user, success: null, error: 'New passwords do not match' });
  }
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.session.userId);

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.render('settings', { user, success: null, error: 'Incorrect current password' });
    }

    user.password = newPassword;
    await user.save();
    res.render('settings', { user, success: 'Password updated successfully', error: null });
  } catch (error) {
    console.error(error);
    const user = await User.findById(req.session.userId);
    res.render('settings', { user, success: null, error: 'Error updating password' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;