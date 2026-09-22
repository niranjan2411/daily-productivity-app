const mongoose = require('mongoose');

const platformVisitSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  visitDate: {
    type: Date,
    required: true,
    index: true,
    default: () => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      return date;
    }
  },
  lastSeenAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

platformVisitSchema.index({ userId: 1, visitDate: 1 }, { unique: true });
platformVisitSchema.index({ visitDate: 1, userId: 1 });

module.exports = mongoose.model('PlatformVisit', platformVisitSchema);
