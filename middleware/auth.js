const jwt = require('jsonwebtoken');

const authenticateUser = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  res.redirect('/login');
};

module.exports = { authenticateUser };
