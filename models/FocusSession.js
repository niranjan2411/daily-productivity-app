const mongoose = require('mongoose');

const focusSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  durationSeconds: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['completed'],
    default: 'completed'
  },
  source: {
    type: String,
    enum: ['dashboard-timer'],
    default: 'dashboard-timer'
  }
}, { timestamps: true });

focusSessionSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
focusSessionSchema.index({ userId: 1, status: 1, endTime: 1 });
focusSessionSchema.index({ status: 1, endTime: 1, userId: 1 });

module.exports = mongoose.model('FocusSession', focusSessionSchema);