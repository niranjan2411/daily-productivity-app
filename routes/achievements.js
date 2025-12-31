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

    // **NEW: Total Hours Achievements**
    { id: 'hours-100', name: 'Century Scholar', description: 'Study for 100 hours in total.', type: 'total_hours', requiredHours: 100, icon: `<i class="bi bi-hourglass-bottom"></i>`, check: (logs, user) => checkTotalHours(logs, 100) },
    { id: 'hours-500', name: 'Dedicated Learner', description: 'Study for 500 hours in total.', type: 'total_hours', requiredHours: 500, icon: `<i class="bi bi-hourglass-split"></i>`, check: (logs, user) => checkTotalHours(logs, 500) },
    { id: 'hours-1000', name: 'Master of Time', description: 'Study for 1,000 hours in total.', type: 'total_hours', requiredHours: 1000, icon: `<i class="bi bi-hourglass-top"></i>`, check: (logs, user) => checkTotalHours(logs, 1000) },
    { id: 'hours-1500', name: 'Productivity Pro', description: 'Study for 1,500 hours in total.', type: 'total_hours', requiredHours: 1500, icon: `<i class="bi bi-clock-history"></i>`, check: (logs, user) => checkTotalHours(logs, 1500) },
    { id: 'hours-2000', name: 'Focused Mind', description: 'Study for 2,000 hours in total.', type: 'total_hours', requiredHours: 2000, icon: `<i class="bi bi-speedometer2"></i>`, check: (logs, user) => checkTotalHours(logs, 2000) },
    { id: 'hours-3000', name: 'Scholar Elite', description: 'Study for 3,000 hours in total.', type: 'total_hours', requiredHours: 3000, icon: `<i class="bi bi-rocket-takeoff"></i>`, check: (logs, user) => checkTotalHours(logs, 3000) },
    { id: 'hours-5000', name: 'Legendary Sage', description: 'Study for 5,000 hours in total.', type: 'total_hours', requiredHours: 5000, icon: `<i class="bi bi-infinity"></i>`, check: (logs, user) => checkTotalHours(logs, 5000) },
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

// **NEW: Check Function for Total Hours**
function checkTotalHours(logs, requiredHours) {
    const total = logs.reduce((acc, log) => acc + log.hours, 0);
    return total >= requiredHours;
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