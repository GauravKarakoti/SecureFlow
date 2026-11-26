# Enforce Parameterized Queries

## Problem
Constructing SQL queries using string concatenation or interpolation with untrusted user input allows attackers to manipulate SQL command structure, leading to SQL Injection (SQLi). SQL injection vulnerabilities allow unauthorized attackers to bypass authentication, read sensitive records, corrupt database tables, or execute administrative commands.

## Example
```javascript
// Vulnerable: raw query using direct string interpolation
const query = `SELECT * FROM users WHERE email = '${req.body.email}' AND active = true`;
const user = await db.query(query);
```

## Fix
Use parameterized queries, prepared statements, or ORM/query builder abstractions with parameterized placeholders.

```javascript
// Remediated: parameterized query with positional parameters
const query = "SELECT * FROM users WHERE email = $1 AND active = true";
const user = await db.query(query, [req.body.email]);
```
