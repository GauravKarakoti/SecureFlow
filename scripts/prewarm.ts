import 'dotenv/config';

async function prewarm() {
  console.log('🔥 Pre-warming GitHub webhook route...');
  
  const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/github`;
  const maxRetries = 5;
  let retries = maxRetries;
  
  while (retries > 0) {
    try {
      // Use an AbortController so fetch doesn't hang indefinitely if the server is stalled
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-hub-signature-256': 'sha256=dummy',
          'x-github-event': 'pull_request',
        },
        body: '{}',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      // We expect a 401 Invalid Signature, which means it compiled and ran the handler
      // We also accept 200/202 just in case the auth logic changes later
      if (res.status === 401 || res.ok) {
        console.log(`✅ Route compiled and pre-warmed successfully! (Status: ${res.status})`);
        return; // Exit successfully
      } else {
        console.warn(`⚠️ Server responded with status ${res.status}. Retrying...`);
      }
    } catch (error: any) {
      // Differentiate between connection refused (server not up) and timeouts
      if (error.name === 'AbortError') {
        console.warn('⚠️ Request timed out. Server might still be compiling...');
      } else {
        console.warn(`⚠️ Connection failed (${error.code || error.message}). Waiting for server...`);
      }
    }

    retries -= 1;
    
    if (retries === 0) {
      console.error('❌ Pre-warming failed after maximum retries. Ensure the server is running on port 9002.');
      process.exit(1);
    }

    // Progressive backoff: 2s, then 4s, then 6s...
    const backoffTime = (maxRetries - retries) * 2000;
    await new Promise(resolve => setTimeout(resolve, backoffTime));
  }
}

prewarm();