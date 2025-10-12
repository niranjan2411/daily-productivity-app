const mongoose = require('mongoose');

const achievementSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  achievementId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  achieved: {
    type: Boolean,
    default: false
  },
  dateAchieved: {
    type: Date
  },
  notified: {
    type: Boolean,
    default: false
  },
  // **NEW: Field to store the goal value at the time of achievement**
  goalValueOnAchieved: {
    type: Number,
    required: false // Only required for goal-based achievements
  }
});

achievementSchema.index({ userId: 1, achievementId: 1 }, { unique: true });

module.exports = mongoose.model('Achievement', achievementSchema);