const mongoose = require('mongoose');

const privateGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 60
  },
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    minlength: 8,
    maxlength: 8,
    match: /^[A-Z0-9]+$/
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, { timestamps: true });

privateGroupSchema.index({ members: 1 });

module.exports = mongoose.model('PrivateGroup', privateGroupSchema);
