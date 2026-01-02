# Daily Productivity Tracker

A full-stack, gamified web application designed to help you build consistent habits, track daily study hours, and visualize long-term progress. Built with Node.js, Express, and MongoDB, it leverages gamification elements like XP, levels, and achievements to keep you motivated.

**Live Demo:** [**https://tracku.me/**](https://tracku.me/)

---

## 🚀 Key Features

### 🎮 Gamification & Motivation
* **Leveling System:** Earn **10 XP** per hour studied and **50 XP** bonuses for hitting your daily goal. Level up every 1000 XP.
* **XP History:** View a detailed log of every XP point earned (study sessions, streaks, and achievements) via the interactive XP counter.
* **Achievement System:** Unlock badges for consistency (e.g., "7-Day Streak") and total hours. Notifications alert you immediately upon unlocking.
* **Streak Tracking:** Monitor distinct streaks for **Consistency** (logging any hours) and **Discipline** (meeting daily goals).

### 📊 Advanced Analytics
* **Interactive Dashboard:** Features a "Today's Focus" circular progress ring, a 3-day quick history view, and real-time level progress.

    <img width="800" height="500" alt="dashboard" src="https://github.com/user-attachments/assets/afd627fc-157c-479e-8985-f61159be3d71" />


  
* **Deep-Dive Charts:**
    * **Distribution Analysis:** View total/average hours for the past 7 days, 30 days, 6 months, or all-time.
    * **Productivity by Day:** Bar chart breaking down which days of the week you are most productive.
    * **Goal Achievement Rate:** Doughnut chart visualizing how often you meet your daily targets.
    * **Scrollable History:** A swipeable monthly bar chart covering your entire usage history.
    * **Custom Ranges:** Generate reports for specific date ranges to analyze exam weeks or project sprints.
 
      <img width="800" height="500" alt="analytics" src="https://github.com/user-attachments/assets/20ef3918-f4df-4dc2-8a7b-23d8e6b23b49" />


### ⚡ User Experience & Utility
* **Quick Log Modal:** Log hours instantly from the dashboard without navigating away.
* **Heatmap Calendar:** A GitHub-style contribution graph providing a granular, color-coded view of your monthly effort.
* **Responsive Design:** Fully optimized interface for desktop, tablet, and mobile devices.

  <img width="800" height="500" alt="calendar" src="https://github.com/user-attachments/assets/8026c595-1c75-416f-b36d-e35954f84a54" />

  <img width="800" height="500" alt="achievement" src="https://github.com/user-attachments/assets/c368efe1-c3c8-4d30-8ad3-d0e7f0b386d9" />


### 🛡️ Security & Performance
* **Secure Auth:** `bcryptjs` for password hashing and `express-session` with MongoDB storage for persistent, secure sessions.
* **Protection:** Implemented `express-rate-limit` to prevent brute-force attacks and `express-validator` for robust input sanitization.
* **Optimization:** Database connection "keep-warm" strategies and optimized queries for fast page loads.

---

## 🛠️ Tech Stack

### Backend
* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** MongoDB (via Mongoose ODM)
* **Authentication:** Express-Session, Connect-Mongo, Bcryptjs
* **Validation:** Express-Validator

### Frontend
* **Templating:** EJS (Embedded JavaScript)
* **Styling:** Custom CSS (Responsive Grid & Flexbox)
* **Visualization:** Chart.js (Interactive canvas-based charts)

---

## ⚙️ Local Installation

Follow these steps to set up the project locally for development.

### Prerequisites
* Node.js (v16+)
* npm
* MongoDB URI (Local or Atlas)

### Steps

1.  **Clone the repository**
    ```bash
    git clone [https://github.com/niranjan2411/daily-productivity-app.git](https://github.com/niranjan2411/daily-productivity-app.git)
    cd daily-productivity-app
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables**
    Create a `.env` file in the root directory and add the following:
    ```env
    PORT=3000
    MONGODB_URI=your_mongodb_connection_string
    SESSION_SECRET=your_secret_key_here
    NODE_ENV=development
    ```

4.  **Start the server**
    ```bash
    # For development (with nodemon)
    npm run dev

    # For production
    npm start
    ```

5.  **Access the App**
    Open your browser and navigate to `http://localhost:3000`.

---

## 📖 Usage Guide

1.  **Set Your Baseline:** Upon registering, head to **Settings** to define your "Daily Goal" (e.g., 4 hours). This value drives your streak calculations and XP bonuses.
2.  **Log Activity:** Use the **"Add Study Hours"** button on the dashboard for quick entry, or use the **Calendar** for back-dating entries.
3.  **Monitor Growth:** Check the **Analytics** tab weekly to identify trends. Use the "Day of Week" chart to optimize your schedule around your most productive days.
4.  **Data Management:** You can clear your study logs or update your password securely from the Settings page.

---

## 🤝 Contributing

Contributions are welcome! If you have suggestions for new charts, gamification features, or UI improvements:

1.  Fork the project.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.
