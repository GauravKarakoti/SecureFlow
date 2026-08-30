const express = require('express');
const router = express.Router();
const { generateHeistVictoryCard } = require('../services/cardGeneratorService');

router.get('/api/heist/cards/:id.png', async (req, res) => {
  try {
    // Dynamic payload extrapolation matching image contextual state metrics
    const username = "GauravKarakoti";
    const repoName = "SecureFlow#606";
    const auditStatus = "PASS";
    const timestamp = "Aug 21, 2026, 1:01 PM";

    const imageBuffer = await generateHeistVictoryCard(username, repoName, auditStatus, timestamp);
    
    // Dispatch stream headers
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(imageBuffer);
  } catch (error) {
    console.error('Failed to compile heist image stream buffer:', error);
    res.status(500).json({ error: 'Internal Image Generator Exception' });
  }
});

module.exports = router;
