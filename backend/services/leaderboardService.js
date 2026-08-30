/* eslint-disable */
const { User, PullRequest, SecurityScore } = require('../models');
const { Op } = require('sequelize');

async function getMostWantedLeaderboard() {
  try {
    // Aggregates clean, merged work that earned bounties
    const leaderboard = await User.findAll({
      attributes: ['id', 'username', 'avatarUrl', 'securityScore'],
      include: [{
        model: PullRequest,
        as: 'pullRequests',
        attributes: [],
        where: {
          status: 'MERGED',
          isClean: true // Ensure only non-vulnerable work ranks
        }
      }],
      order: [
        ['securityScore', 'DESC'],
        ['username', 'ASC']
      ],
      group: ['User.id'],
      having: sequelize.literal('COUNT(pullRequests.id) > 0')
    });

    return leaderboard;
  } catch (error) {
    console.error('Failed to populate leaderboard metrics:', error);
    throw error;
  }
}

module.exports = { getMostWantedLeaderboard };
