// **UPDATED: Pop-up function now accepts the icon HTML**
function showAchievementPopup(name, description, type, goalValue, icon) {
  if (document.querySelector('.achievement-popup')) return;

  let goalInfo = '';
  if (type === 'goal' && goalValue) {
    goalInfo = `<p class="popup-goal-value">Achieved with a daily goal of ${goalValue} hours!</p>`;
  }

  const popup = document.createElement('div');
  popup.className = 'achievement-popup';
  popup.innerHTML = `
    <div class="achievement-popup-content">
      <div class="popup-header">CONGRATS!</div>
      <div class="popup-icon">${icon}</div>
      <h3>${name}</h3>
      <p>${description}</p>
      ${goalInfo} 
      <button class="btn-popup" onclick="closePopup()">GOT IT</button>
    </div>
  `;
  document.body.appendChild(popup);
  
  showPartyConfetti();
}

function closePopup() {
  const popup = document.querySelector('.achievement-popup');
  if (popup) {
    popup.remove();
  }
}

function showPartyConfetti() {
  const confettiContainer = document.createElement('div');
  confettiContainer.className = 'confetti-container';
  document.body.appendChild(confettiContainer);

  const emojis = ['🏆', '🎉', '✨', '🌟', '🏅'];
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti-emoji';
    confetti.innerText = emojis[Math.floor(Math.random() * emojis.length)];
    confetti.style.left = Math.random() * 100 + 'vw';
    confetti.style.animationDuration = Math.random() * 2 + 3 + 's';
    confetti.style.fontSize = Math.random() * 20 + 15 + 'px';
    confettiContainer.appendChild(confetti);
  }

  setTimeout(() => {
    confettiContainer.remove();
  }, 4000);
}

function checkAndShowAchievements() {
  fetch('/api/achievements/check')
    .then(response => response.json())
    .then(data => {
      if (data.newAchievements && data.newAchievements.length > 0) {
        data.newAchievements.forEach((achievement, index) => {
          const definition = achievementsList.find(a => a.id === achievement.achievementId);
          const iconHTML = definition ? definition.icon : '';
          
          setTimeout(() => {
            showAchievementPopup(
              achievement.name, 
              achievement.description,
              achievement.achievementId.includes('goal') ? 'goal' : 'consistency',
              achievement.goalValueOnAchieved,
              iconHTML
            );
          }, index * 4000);
        });
      }
    });
}