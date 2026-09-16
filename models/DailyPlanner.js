const mongoose = require('mongoose');

const plannerTaskSchema = new mongoose.Schema({
  taskId: { type: String, required: true },
  title: { type: String, required: true, trim: true, maxlength: 240 },
  completed: { type: Boolean, default: false }
}, { _id: false });

const plannerListSchema = new mongoose.Schema({
  listId: { type: String, required: true },
  title: { type: String, required: true, trim: true, maxlength: 80 },
  tasks: { type: [plannerTaskSchema], default: [] }
}, { _id: false });

const dailyPlannerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
    index: true
  },
  lists: { type: [plannerListSchema], default: [] },
  note: { type: String, default: '', maxlength: 10000 }
}, { timestamps: true });

dailyPlannerSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyPlanner', dailyPlannerSchema);
