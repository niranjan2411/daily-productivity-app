const express = require('express');
const router = express.Router();
const Achievement = require('../models/Achievement');
const StudyLog = require('../models/StudyLog');
const User = require('../models/User');
const { authenticateUser } = require('../middleware/auth');

// **UPDATED: Added 'requiredDays' to each achievement object for reliable calculations**
const achievementsList = [
    // Consistency Achievements
    { id: 'consistency-7', name: '7-Day Streak', description: 'Study for 7 days in a row.', type: 'consistency', requiredDays: 7, icon: `<i class="bi bi-fire"></i>`, check: (logs, user) => checkConsistency(logs, 7) },
    { id: 'consistency-21', name: '21-Day Habit', description: 'Study for 21 days in a row.', type: 'consistency', requiredDays: 21, icon: `<i class="bi bi-calendar2-check"></i>`, check: (logs, user) => checkConsistency(logs, 21) },
    { id: 'consistency-50', name: '50-Day Commitment', description: 'Study for 50 days in a row.', type: 'consistency', requiredDays: 50, icon: `<i class="bi bi-award"></i>`, check: (logs, user) => checkConsistency(logs, 50) },
    { id: 'consistency-100', name: '100-Day Club', description: 'Study for 100 days in a row.', type: 'consistency', requiredDays: 100, icon: `<i class="bi bi-trophy"></i>`, check: (logs, user) => checkConsistency(logs, 100) },
    { id: 'consistency-300', name: '300-Day Milestone', description: 'Study for 300 days in a row.', type: 'consistency', requiredDays: 300, icon: `<i class="bi bi-gem"></i>`, check: (logs, user) => checkConsistency(logs, 300) },
    // Goal-Based Achievements
    { id: 'goal-7', name: 'Goal Setter', description: 'Meet your daily goal for 7 days in a row.', type: 'goal', requiredDays: 7, icon: `<i class="bi bi-flag"></i>`, check: (logs, user) => checkGoalStreak(logs, user, 7) },
    { id: 'goal-21', name: 'Goal Achiever', description: 'Meet your daily goal for 21 days in a row.', type: 'goal', requiredDays: 21, icon: `<i class="bi bi-bullseye"></i>`, check: (logs, user) => checkGoalStreak(logs, user, 21) },
    { id: 'goal-50', name: 'Goal Master', description: 'Meet your daily goal for 50 days in a row.', type: 'goal', requiredDays: 50, icon: `<i class="bi bi-shield-check"></i>`, check: (logs, user) => checkGoalStreak(logs, user, 50) },
    { id: 'goal-100', name: 'Goal Legend', description: 'Meet your daily goal for 100 days in a row.', type: 'goal', requiredDays: 100, icon: `<i class="bi bi-star-fill"></i>`, check: (logs, user) => checkGoalStreak(logs, user, 100) },
    { id: 'goal-300', name: 'Goal Demigod', description: 'Meet your daily goal for 300 days in a row.', type: 'goal', requiredDays: 300, icon: `<i class="bi bi-stars"></i>`, check: (logs, user) => checkGoalStreak(logs, user, 300) },
];

function checkConsistency(logs, requiredStreak) {
    const validLogs = logs.filter(log => log.hours > 0);
    if (validLogs.length < requiredStreak) return false;
    let currentStreak = validLogs.length > 0 ? 1 : 0;
    if (currentStreak >= requiredStreak) return true;
    for (let i = 1; i < validLogs.length; i++) {
        const prevDate = validLogs[i - 1].date;
        const currentDate = validLogs[i].date;
        const diffInDays = (currentDate.getTime() - prevDate.getTime()) / (1000 * 3600 * 24);
        if (diffInDays === 1) {
            currentStreak++;
        } else if (diffInDays > 1) {
            currentStreak = 1;
        }
        if (currentStreak >= requiredStreak) {
            return true;
        }
    }
    return false;
}

function checkGoalStreak(logs, user, requiredStreak) {
    const goalMetLogs = logs.filter(log => log.hours >= user.dailyGoalHours);
    return checkConsistency(goalMetLogs, requiredStreak);
}

router.get('/check', authenticateUser, async (req, res) => {
    try {
        const userId = req.session.userId;
        const newAchievements = await Achievement.find({ userId, notified: false, achieved: true });
        if (newAchievements.length > 0) {
            await Achievement.updateMany(
                { _id: { $in: newAchievements.map(a => a._id) } },
                { $set: { notified: true } }
            );
        }
        res.json({ newAchievements });
    } catch (error) {
        console.error("Achievement check error:", error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = {
    router,
    achievementsList,
};