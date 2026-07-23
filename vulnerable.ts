import { Client } from 'pg';

export async function getUserByUsernameVulnerable(username: string) {
  const client = new Client({});

  try {
    await client.connect();
    console.log(process.env["GROQ_API_KEY"]);
    const query = `SELECT id, username, email FROM users WHERE username = '${username}'`;
    
    console.log(`Executing query: ${query}`);
    
    const result = await client.query(query);
    return result.rows;

  } catch (error) {
    console.error("Database error:", error);
    throw error;
  } finally {
    await client.end();
  }
}