const mongoose = require('mongoose');

const normalizeUtcDate = (value) => {
  if (value === null || value === undefined || value === '') return value;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const studyLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: Date,
    required: true,
    set: normalizeUtcDate
  },
  minutes: {
    type: Number,
    required: false,
    min: 0,
    max: 1439
  },
  hours: {
    type: Number,
    min: 0,
    max: 24
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

studyLogSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('StudyLog', studyLogSchema);