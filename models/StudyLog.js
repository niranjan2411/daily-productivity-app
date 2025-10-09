const mongoose = require('mongoose');

const studyLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  hours: {
    type: Number,
    required: true,
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