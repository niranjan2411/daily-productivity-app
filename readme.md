# Daily Productivity Tracker

A full-stack web application built with Node.js, Express, and MongoDB to help users track their daily study hours, visualize their progress, and achieve their productivity goals.

**Live Demo:** [**https://daily-productivity-app-eight.vercel.app/login**](https://daily-productivity-app-eight.vercel.app/login)

---


## About The Project

This application provides a clean and intuitive interface for users to log the hours they spend studying or working each day. It offers a dashboard for a quick overview, a calendar for a visual representation of daily efforts, and an analytics page to track long-term trends. The goal is to help users stay motivated and consistent by making their progress tangible.

## Features

* **User Authentication:** Secure signup and login functionality with password hashing (`bcrypt.js`) and session management (`express-session`).
* **Dashboard Overview:** At-a-glance view of today's logged hours, total hours (filterable by time range), and the number of recent logs.
* **Interactive Calendar:** A visual grid of the current month where users can log hours for any past or present day and see which days they met their goals.
* **Data Analytics:** A dedicated page with charts to visualize progress over the last 30 days, along with key metrics like weekly average and monthly total hours.
* **Customizable Goals:** Users can set their own daily study hour goals via the settings page.
* **Fully Responsive:** The user interface is designed to be accessible and functional on both desktop and mobile devices.

## Tech Stack

* **Backend:** Node.js, Express.js
* **Frontend:** EJS (Embedded JavaScript templates), CSS
* **Database:** MongoDB with Mongoose ODM
* **Authentication:** `express-session` & `bcrypt.js`

## Getting Started

Follow these instructions to get a local copy of the project up and running on your machine for development and testing purposes.

### Prerequisites

* **Node.js** (v16 or later)
* **npm** (Node Package Manager)
* **MongoDB:** A MongoDB database connection string (you can get a free one from [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register)).

### Installation & Setup

1.  **Clone the repository:**
    ```sh
    git clone [https://github.com/your-username/daily-productivity-app.git](https://github.com/your-username/daily-productivity-app.git)
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

