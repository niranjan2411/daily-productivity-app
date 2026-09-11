const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    default: () => crypto.randomUUID(),
    unique: true,
    sparse: true,
    immutable: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  username: {
    type: String,
    unique: true,
    required: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 30,
    match: /^[a-z0-9_]+$/
  },
  publicProfile: {
    type: Boolean,
    default: false
  },
  timeUnit: {
    type: String,
    enum: ['minutes', 'hours'],
    default: 'minutes'
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  dailyGoalMinutes: {
    type: Number,
    default: 300,
    min: 1,
    max: 1440
  },
  dailyGoalHours: {
    type: Number,
    min: 0.5,
    max: 24
  },
  totalFocusMinutes: {
    type: Number,
    default: 0,
    min: 0
  },
  averageWeeklyFocusMinutes: {
    type: Number,
    default: 0,
    min: 0
  },
  averageMonthlyFocusMinutes: {
    type: Number,
    default: 0,
    min: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);