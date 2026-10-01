# TrackU

TrackU is a full-stack productivity tracker for planning focused work, recording study or work sessions, and understanding progress over time.

Live demo: [https://tracku.me/](https://tracku.me/)

## Features

### Daily productivity

- Daily todo planner with task creation, completion, deletion, reordering, and moving tasks to the next day.
- Date-based planner navigation with daily notes.
- Quick focus-log modal for adding or resetting manual study time.
- Daily goal tracking with a visual Today’s Focus progress ring.
- Responsive dashboard for desktop, tablet, and mobile screens.

### Persistent focus timer

- Start and pause focus sessions directly from the dashboard.
- Running sessions continue correctly through page refreshes.
- Timer state and elapsed time are persisted per user and synchronized across open tabs.
- Active elapsed time is reflected immediately in the timer, Today’s Focus display, and total focus display.
- Completed sessions are saved to MongoDB with idempotent session IDs to prevent duplicate records.

### Progress and insights

- XP, levels, daily-goal bonuses, and achievement milestones.
- Separate consistency and goal streak tracking.
- XP history for achievements, manual logs, and completed focus sessions.
- Calendar heatmaps and date-specific focus history.
- Analytics for focus distribution, productivity by weekday, goal completion, history, and custom date ranges.
- Leaderboards for public profiles across daily, weekly, monthly, and yearly ranges.

### Profiles and collaboration

- Private and public user profiles.
- Public profile totals and progress summaries.
- Private groups with member management and group activity views.
- Settings for daily goals, time display preferences, password updates, profile visibility, and account data management.

### Performance and security

- Short private caching for dashboard HTML to make repeat loads faster.
- Non-blocking visit tracking so analytics writes do not delay page rendering.
- Local task snapshots for instant daily planner rendering, followed by server reconciliation.
- MongoDB indexes for user/date planner queries and focus-session reporting.
- Password hashing with `bcryptjs`.
- Persistent sessions with `express-session` and `connect-mongo`.
- Request limiting with `express-rate-limit`.
- Input validation with `express-validator`.

## Tech stack

### Backend

- Node.js
- Express 5
- MongoDB with Mongoose
- EJS server-side templates
- Express Session and Connect Mongo
- Bcryptjs
- Express Validator

### Frontend

- Server-rendered EJS views
- Custom responsive CSS
- Vanilla JavaScript for the dashboard, planner, timer, and interactions
- Bootstrap Icons via CDN

## Local setup

### Prerequisites

- Node.js 16 or newer
- npm
- MongoDB locally or through MongoDB Atlas

### Installation

```bash
git clone https://github.com/niranjan2411/daily-productivity-app.git
cd daily-productivity-app
npm install
```

Create a `.env` file in the project root:

```env
PORT=3000
MONGODB_URI=your_mongodb_connection_string
MONGODB_DB=productivity_tracker
SESSION_SECRET=your_secret_key_here
NODE_ENV=development
```

Use the same `MONGODB_URI`, `MONGODB_DB`, and `SESSION_SECRET` for local and hosted environments when they should share users, logs, settings, and sessions. Never commit `.env` or expose its values in source code.

Start the application:

```bash
# Development with automatic restart
npm run dev

# Standard start
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Typical workflow

1. Create an account and set a daily focus goal in Settings.
2. Add the day’s priorities in the planner.
3. Start the focus timer when work begins and pause it when the session ends.
4. Use the quick-log modal or Calendar for manual or backdated time.
5. Review Today’s Focus, streaks, achievements, Analytics, and calendar history.
6. Enable a public profile when you want to participate in leaderboards or share progress.

## Project structure

```text
server.js                 Express application and route handlers
api/                      Deployment entry point
lib/                      Database connection helpers
middleware/               Authentication middleware
models/                   Mongoose schemas
routes/                   Feature-specific route modules
public/css/               Shared stylesheets
public/js/                Dashboard, planner, and achievement scripts
views/                    EJS pages and partials
```

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the production-style server |
| `npm run dev` | Start the server with Nodemon |

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Make and validate your changes.
4. Commit and push the branch.
5. Open a pull request.
