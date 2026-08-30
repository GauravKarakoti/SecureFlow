const { createCanvas, registerFont } = require('canvas');

async function generateHeistVictoryCard(username, repoName, auditStatus, timestamp) {
  // Define standard sharing dimensions (1200x630)
  const canvas = createCanvas(1200, 630);
  const ctx = canvas.getContext('2d');

  // 1. Dark Aesthetic Background Base
  ctx.fillStyle = '#0F111A';
  ctx.fillRect(0, 0, 1200, 630);

  // Decorative cyber grid background lines
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.05)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 1200; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 630);
    ctx.stroke();
  }

  // 2. Ingest Glowing Title Card Elements
  ctx.fillStyle = '#EF4444'; // Tactical Red
  ctx.font = 'bold 32px Helvetica';
  ctx.fillText('HEIST VICTORY CERTIFICATE', 80, 100);

  // 3. Render Audit Metrics & Clearing Variables
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 56px Helvetica';
  ctx.fillText(username, 80, 240);

  ctx.fillStyle = '#9CA3AF';
  ctx.font = '28px Helvetica';
  ctx.fillText(`Target: ${repoName}`, 80, 310);
  ctx.fillText(`Cleared: ${timestamp}`, 80, 370);

  // 4. Ingest Verification Badge Status Panel
  ctx.fillStyle = '#10B981'; // Success Green
  ctx.fillRect(80, 450, 320, 70);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px Helvetica';
  ctx.textAlign = 'center';
  ctx.fillText(`AUDIT STATUS: ${auditStatus}`, 240, 495);

  return canvas.toBuffer('image/png');
}

module.exports = { generateHeistVictoryCard };
