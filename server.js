require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');

const User = require('./models/User');
const StudyLog = require('./models/StudyLog');
const { sendOTPEmail, sendPasswordResetEmail } = require('./utils/emailService');
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
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true 
  }
}));

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/signup');
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.render('signup', { error: 'Email already registered' });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    const user = new User({
      name,
      email,
      password,
      otp,
      otpExpiry,
      isVerified: false
    });

    await user.save();
    await sendOTPEmail(email, otp, name);

    req.session.tempUserId = user._id;
    res.redirect('/verify-otp');
  } catch (error) {
    console.error(error);
    res.render('signup', { error: 'Server error occurred' });
  }
});

app.get('/verify-otp', (req, res) => {
  if (!req.session.tempUserId) {
    return res.redirect('/signup');
  }
  res.render('verify-otp', { error: null, type: 'signup' });
});

app.post('/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    const user = await User.findById(req.session.tempUserId);

    if (!user) {
      return res.render('verify-otp', { error: 'User not found', type: 'signup' });
    }

    if (user.otp !== otp) {
      return res.render('verify-otp', { error: 'Invalid OTP', type: 'signup' });
    }

    if (new Date() > user.otpExpiry) {
      return res.render('verify-otp', { error: 'OTP expired', type: 'signup' });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpiry = null;
    await user.save();

    req.session.userId = user._id;
    delete req.session.tempUserId;
    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.render('verify-otp', { error: 'Server error occurred', type: 'signup' });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.render('login', { error: 'Invalid email or password' });
    }

    if (!user.isVerified) {
      return res.render('login', { error: 'Please verify your email first' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.render('login', { error: 'Invalid email or password' });
    }

    req.session.userId = user._id;
    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.render('login', { error: 'Server error occurred' });
  }
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, success: null });
});

app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.render('forgot-password', { error: 'Email not found', success: null });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    await sendPasswordResetEmail(email, otp, user.name);

    req.session.resetUserId = user._id;
    res.render('forgot-password', { error: null, success: 'OTP sent to your email' });
  } catch (error) {
    console.error(error);
    res.render('forgot-password', { error: 'Server error occurred', success: null });
  }
});

app.get('/reset-password', (req, res) => {
  if (!req.session.resetUserId) {
    return res.redirect('/forgot-password');
  }
  res.render('reset-password', { error: null });
});

app.post('/reset-password', async (req, res) => {
  try {
    const { otp, newPassword } = req.body;
    const user = await User.findById(req.session.resetUserId);

    if (!user) {
      return res.render('reset-password', { error: 'User not found' });
    }

    if (user.otp !== otp) {
      return res.render('reset-password', { error: 'Invalid OTP' });
    }

    if (new Date() > user.otpExpiry) {
      return res.render('reset-password', { error: 'OTP expired' });
    }

    user.password = newPassword;
    user.otp = null;
    user.otpExpiry = null;
    await user.save();

    delete req.session.resetUserId;
    res.redirect('/login');
  } catch (error) {
    console.error(error);
    res.render('reset-password', { error: 'Server error occurred' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});



////////////////////////
app.get('/dashboard', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
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

    const totalHours = await StudyLog.aggregate([
      { $match: { userId: user._id } },
      { $group: { _id: null, total: { $sum: '$hours' } } }
    ]);

    res.render('dashboard', {
      user,
      todayHours: todayLog ? todayLog.hours : 0,
      recentLogs,
      totalHours: totalHours.length > 0 ? totalHours[0].total : 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/calendar', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    
    const currentMonth = req.query.month ? new Date(req.query.month) : new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);
    
    const nextMonth = new Date(currentMonth);
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    const logs = await StudyLog.find({
      userId: req.session.userId,
      date: { $gte: currentMonth, $lt: nextMonth }
    });

    res.render('calendar', { user, logs, currentMonth });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/add-study-log', authenticateUser, async (req, res) => {
  try {
    const { date, hours, notes } = req.body;
    
    const logDate = new Date(date);
    logDate.setHours(0, 0, 0, 0);

    const existingLog = await StudyLog.findOne({
      userId: req.session.userId,
      date: logDate
    });

    if (existingLog) {
      existingLog.hours = parseFloat(hours);
      existingLog.notes = notes || '';
      await existingLog.save();
    } else {
      const newLog = new StudyLog({
        userId: req.session.userId,
        date: logDate,
        hours: parseFloat(hours),
        notes: notes || ''
      });
      await newLog.save();
    }

    res.redirect('/calendar');
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/analytics', authenticateUser, async (req, res) => {
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

app.get('/settings', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    res.render('settings', { user, success: null, error: null });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.post('/update-goal', authenticateUser, async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
