async function prewarm() {
  console.log('🔥 Pre-warming GitHub webhook route...');
  
  // Retry loop in case the server takes a moment to bind to the port
  let retries = 5;
  while (retries > 0) {
    try {
      const res = await fetch('http://localhost:9002/api/webhooks/github', {
        method: 'POST',
        headers: {
          'x-hub-signature-256': 'sha256=dummy',
          'x-github-event': 'pull_request',
        },
        body: '{}',
      });
      
      // We expect a 401 Invalid Signature, which means it compiled and ran the handler!
      if (res.status === 401) {
        console.log('✅ Route compiled and pre-warmed successfully!');
        break;
      }
    } catch (error) {
      retries -= 1;
      if (retries === 0) {
        console.error('❌ Pre-warming failed. Ensure the server is running on port 9002.');
      } else {
        // Wait 2 seconds before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

prewarm();