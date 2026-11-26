# Prevent Unsafe DOM Injection (XSS)

## Problem
Directly injecting untrusted or unsanitized strings into web page DOM elements using `dangerouslySetInnerHTML`, `innerHTML`, `document.write()`, or `eval()` enables Cross-Site Scripting (XSS). Attackers can execute malicious client scripts, steal session cookies, or impersonate users.

## Example
```javascript
// Vulnerable: injecting raw unescaped user string into DOM
function CommentView({ commentHtml }) {
  return <div dangerouslySetInnerHTML={{ __html: commentHtml }} />;
}
```

## Fix
Sanitize untrusted HTML with DOMPurify prior to injection, or render user values as standard React JSX text bindings which automatically escape HTML entities.

```javascript
// Remediated: sanitized HTML payload
import DOMPurify from "dompurify";

function CommentView({ commentHtml }) {
  const cleanHtml = DOMPurify.sanitize(commentHtml);
  return <div dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
}
```
