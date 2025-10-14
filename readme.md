# Daily Productivity Tracker

A full-stack, gamified web application built with Node.js, Express, and MongoDB to help you track daily study hours, visualize your progress, and stay motivated by earning XP and unlocking achievements.

**Live Demo:** [**https://tracku.me/login**](https://tracku.me/login)

---

## About The Project

This application provides a clean and intuitive interface for users to log the hours they spend studying or working each day. It offers a comprehensive dashboard for a quick overview, a dynamic heatmap calendar for a granular view of daily efforts, and a detailed analytics page to track long-term trends. The goal is to help you stay motivated and consistent by making your progress tangible through gamification elements like experience points (XP), levels, and achievements.

---

## Features

* **Secure User Authentication:** Safe and secure signup and login functionality with password hashing (`bcrypt.js`) and persistent session management (`express-session`).
* **Gamified Dashboard:**
    * **XP & Leveling System:** Earn XP for studying, meeting daily goals, and unlocking achievements to level up.
    * **XP History:** Click on the XP counter to see a detailed, scrollable history of all XP earned.
    * **Streak Tracking:** Monitor your current and maximum streaks for both daily consistency and meeting your study goals.
    * **Dynamic Stats:** Get an at-a-glance view of today's logged hours, total hours (filterable by time range), and new achievements.
* **Productivity Heatmap Calendar:**
    * A visual, GitHub-style grid of the current month.
    * Log hours for any past or present day.
    * Days are color-coded to provide a granular view of your productivity:
        * **Red Scale (Below Goal):** Days with 0 hours are bright red. The color fades as you get closer to your goal.
        * **Green Scale (Goal Met):** The color gets progressively darker as you exceed your daily goal, similar to GitHub's contribution graph.
* **In-Depth Analytics:**
    * A dedicated page with interactive charts to visualize your progress.
    * Track trends over the last 30 days, analyze custom date ranges, and perform a deep dive into any month.
    * View key metrics like your weekly average and monthly total study hours.
* **Achievement System:**
    * Unlock dozens of achievements for consistency and meeting your goals (e.g., "7-Day Streak," "Goal Master").
    * Receive pop-up notifications for new achievements.
    * View your completed and in-progress achievements on a dedicated page.
* **Customizable Goals & Settings:**
    * Set and update your personal daily study hour goal at any time.
    * Securely update your password.
    * Option to clear all your study data without deleting your account.
* **Fully Responsive:** The user interface is designed to be accessible and functional on both desktop and mobile devices.

---

## How to Use This App

### 1. Getting Started
* **Sign Up:** Create a new account with your name, email, and a secure password.
* **Login:** Access your dashboard using your credentials.
* **Set Your Goal:** Navigate to the **Settings** page from the top navigation bar to set your initial daily study hour goal. This is crucial for tracking your progress accurately.

### 2. The Dashboard
Your dashboard is your mission control center. Here you can:
* **Track Your Level and XP:** Keep an eye on your current level and XP. Click the XP box to view a detailed history of your earnings.
* **Monitor Your Streaks:** See how many consecutive days you've studied and how many days in a row you've met your daily goal.
* **View Key Stats:** Quickly check your study hours for the current day and your total hours over different time ranges (past 7 days, 1 month, etc.).
* **Access Achievements:** A notification badge will appear on the "My Achievements" button if you have new achievements to view.

### 3. Logging Your Hours
* Navigate to the **Calendar** page.
* Use the form at the top to select a date and enter the number of hours you studied.
* Click **Save**. The calendar will instantly update with the new data, and the color of the day will change to reflect your productivity.

### 4. Analyzing Your Progress
* Go to the **Analytics** page to see your progress visualized.
* **30-Day Progress:** The default line chart shows your study hours over the last 30 days against your daily goal.
* **Custom Date Range:** Select a start and end date and click "Generate Chart" to see a bar chart of your performance over that specific period.
* **Monthly Deep Dive:** Choose a month to see a detailed line chart of your study habits for that month.

---

## Tech Stack

* **Backend:** Node.js, Express.js
* **Frontend:** EJS (Embedded JavaScript templates), CSS, JavaScript
* **Database:** MongoDB with Mongoose ODM
* **Authentication:** `express-session` & `bcrypt.js`

---

## Getting Started Locally

Follow these instructions to get a local copy of the project up and running on your machine for development and testing purposes.

### Prerequisites

* **Node.js** (v16 or later)
* **npm** (Node Package Manager)
* **MongoDB:** A MongoDB database connection string (you can get a free one from [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register)).

### Installation & Setup

1.  **Clone the repository:**
    ```sh
    git clone [https://github.com/niranjan2411/daily-productivity-app.git](https://github.com/niranjan2411/daily-productivity-app.git)
    ```

2.  **Navigate to the project directory:**
    ```sh
    cd daily-productivity-app
    ```

3.  **Install NPM packages:**
    ```sh
    npm install
    ```

4.  **Create a `.env` file:** Create a file named `.env` in the root of the project and add the following environment variables.

    ```env
    MONGODB_URI=your_mongodb_connection_string
    SESSION_SECRET=a_strong_and_random_secret_key
    ```

5.  **Run the development server:**
    ```sh
    npm run dev
    ```
    The application will be available at `http://localhost:3000`.