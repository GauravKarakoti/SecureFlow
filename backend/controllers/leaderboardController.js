const express = require('express');
const router = express.Router();
const { getMostWantedLeaderboard } = require('../services/leaderboardService');

router.get('/api/leaderboard/most-wanted', async (req, res) => {
  try {
    const data = await getMostWantedLeaderboard();
    
    // Always return an array to prevent client rendering crashes
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error compiling scoreboard profiles' });
  }
});

module.exports = router;
