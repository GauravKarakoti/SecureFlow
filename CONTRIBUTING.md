
# 🤝 Contributing to SecureFlow

<div align="center">

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/pulls)
[![Contributors](https://img.shields.io/github/contributors/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/graphs/contributors)
[![GitHub issues](https://img.shields.io/github/issues/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/pulls)

</div>

> **First off, thank you for considering contributing to SecureFlow!**  
> It's people like you that make open-source projects great. This document provides guidelines and instructions for contributing to this repository.

---

## 📋 Table of Contents

- [📜 Code of Conduct](#-code-of-conduct)
- [🚀 Tech Stack](#-tech-stack)
- [🛠️ Development Workflow](#️-development-workflow)
- [📁 Branching Strategy](#-branching-strategy)
- [📝 Commit Guidelines](#-commit-guidelines)
- [🔄 Contribution Lifecycle](#-contribution-lifecycle)
- [🔧 Development Setup](#-development-setup)
- [🐛 Issue Workflow](#-issue-workflow)
- [✅ Pull Request Process](#-pull-request-process)
- [💻 Coding Standards](#-coding-standards)
- [📚 Documentation Standards](#-documentation-standards)
- [🧪 Testing Guidelines](#-testing-guidelines)
- [📁 Folder Structure Explained](#-folder-structure-explained)
- [💡 Tips for First-Time Contributors](#-tips-for-first-time-contributors)
- [❓ FAQ for Contributors](#-faq-for-contributors)
- [🙏 Thank You](#-thank-you)

---

## 📜 Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. We expect all contributors to:

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what's best for the community
- Show empathy towards other community members

---

## 🚀 Tech Stack

Before diving in, please ensure you're familiar with our core stack:

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Database & ORM**: PostgreSQL with Prisma
- **Styling**: Tailwind CSS & Radix UI
- **Authentication**: NextAuth.js v5
- **AI/LLM**: Groq SDK & Genkit
- **GitHub Integration**: Octokit

---

## 🛠️ Development Workflow

```
1. Fork the repository
              ↓
2. Clone your fork locally
              ↓
3. Create a feature branch
              ↓
4. Make your changes
              ↓
5. Run tests and linting
              ↓
6. Commit with conventional format
              ↓
7. Push to your fork
              ↓
8. Open a Pull Request
              ↓
9. Review process
              ↓
10. Merge to main
```

---

## 📁 Branching Strategy

Please follow these naming conventions for your branches:

| Branch Type | Naming Format | Example |
|-------------|---------------|---------|
| **Feature** | `feature/your-feature-name` | `feature/add-policy-engine` |
| **Bug Fix** | `fix/issue-name` | `fix/webhook-timeout` |
| **Documentation** | `docs/documentation-update` | `docs/update-readme` |
| **Refactoring** | `refactor/component-name` | `refactor/dashboard-ui` |
| **Hotfix** | `hotfix/urgent-fix` | `hotfix/auth-bypass` |
| **Chore** | `chore/task-name` | `chore/update-dependencies` |

> ⚠️ **Important**: Always branch from `main` and never commit directly to `main`.

---

## 📝 Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) for consistent and meaningful commit messages.

### Commit Types

| Type | Description | Example |
|------|-------------|---------|
| `feat` | New feature | `feat: add GitHub webhook authentication` |
| `fix` | Bug fix | `fix: resolve PR scanning timeout issue` |
| `docs` | Documentation changes | `docs: update API documentation` |
| `style` | Code style (formatting, whitespace) | `style: format code with Prettier` |
| `refactor` | Code refactoring | `refactor: optimize database queries` |
| `test` | Adding or fixing tests | `test: add unit tests for scanner` |
| `chore` | Build, tooling, dependencies | `chore: update Prisma to v5.0` |
| `perf` | Performance improvements | `perf: improve LLM response time` |
| `ci` | CI/CD changes | `ci: update GitHub Actions workflow` |
| `security` | Security fixes | `security: fix vulnerability in auth` |

### Commit Examples

```
✅ feat: add custom policy creation endpoint
✅ fix: handle empty PR diff gracefully
✅ docs: update contribution guidelines
✅ refactor: improve error handling in webhook
✅ test: add integration tests for GitHub API
✅ chore: update dependencies to latest versions
```

---

## 🔄 Contribution Lifecycle

```
1. Find Issue
   ↓
2. Comment & Assign
   ↓
3. Fork & Branch
   ↓
4. Make Changes
   ↓
5. Self-Review
   ↓
6. Run Tests
   ↓
7. Push Changes
   ↓
8. Open PR
   ↓
9. Pass CI
   ↓
10. Code Review
    ↓
11. Approval
    ↓
12. Merge & Close
```

---

## 🔧 Development Setup

### 1. Fork & Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/SecureFlow.git
cd SecureFlow
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Variables

```bash
cp .env.example .env
```

> 💡 **Tip**: Fill in the required values. See README.md for details.

### 4. Database Setup

```bash
# Generate Prisma Client
npx prisma generate

# Apply migrations
npx prisma migrate dev

# Seed default data
npm run db:seed
```

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:9002](http://localhost:9002) with your browser to see the result.

---

## 🐛 Issue Workflow

1. **Search** existing issues before creating a new one
2. **Use issue templates** when available
3. **Provide clear steps** to reproduce the issue
4. **Include expected vs actual behavior**
5. **Add labels** appropriately (bug, enhancement, etc.)
6. **Assign yourself** if you're working on it
7. **Link related PRs** when submitted

---

## ✅ Pull Request Process

### Before Submitting

- [ ] Fork the repository and create your branch
- [ ] Run `npm run lint` and fix any issues
- [ ] Run `npm run typecheck` and ensure no TypeScript errors
- [ ] Run `npm run build` and confirm it builds
- [ ] Test your changes thoroughly
- [ ] Update documentation if needed

### PR Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code where needed
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings/errors
- [ ] I have added tests that prove my fix/feature works
- [ ] New and existing tests pass locally
- [ ] My commits follow the Conventional Commits format
- [ ] My branch is up-to-date with `main`
- [ ] I have added a detailed description of my changes

### PR Description Template

```markdown
## Description
<!-- Briefly describe what you've changed and why -->

## Type of Change
- [ ] New feature
- [ ] Bug fix
- [ ] Documentation update
- [ ] Refactoring
- [ ] Performance improvement

## Screenshots (if applicable)
<!-- Add before/after screenshots or recordings -->

## Testing
<!-- Describe how you've tested these changes -->

## Related Issues
<!-- Link to related issues using #issue-number -->
Closes #XXX

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have added tests that prove my fix/feature works
- [ ] My commits follow the Conventional Commits format

## Additional Notes
<!-- Any additional information that might be helpful for reviewers -->
```

---

## 💻 Coding Standards

### TypeScript

- Use proper TypeScript types
- Avoid `any` type
- Use interfaces for object shapes
- Add JSDoc comments for public functions

```typescript
// ✅ Good
interface SecurityFinding {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  file: string;
  line: number;
  description: string;
  remediation: string;
}

function processFinding(finding: SecurityFinding): void {
  // ...
}

// ❌ Bad
function processFinding(finding: any): void {
  // ...
}
```

### ESLint

```bash
npm run lint
# or
npx eslint src/ --fix
```

### Prettier

```bash
# Format all files
npx prettier --write .
# Check formatting
npx prettier --check .
```

---

## 📚 Documentation Standards

- Keep documentation **clear and concise**
- Use **proper markdown formatting**
- Add **examples** for complex features
- Update **API documentation** when making changes
- Add **JSDoc comments** for functions and components
- Keep the **README.md** up-to-date

---

## 🧪 Testing Guidelines

### Unit Tests

- Write unit tests for critical functionality
- Use Jest for testing
- Aim for >80% coverage

```typescript
// Example unit test
import { scanForSecrets } from '@/lib/armor/scanner';

describe('scanForSecrets', () => {
  it('should detect hardcoded API keys', () => {
    const code = 'const apiKey = "sk-1234567890";';
    const findings = scanForSecrets(code);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('HARDCODED_SECRET');
  });
});
```

### Integration Tests

- Test API endpoints
- Test database operations
- Test GitHub integration

---

## 📁 Folder Structure Explained

```
src/
├── ai/                    # AI and LLM related code
│   └── flows/             # Genkit AI flows
├── app/                   # Next.js App Router
│   ├── api/               # API routes
│   │   ├── auth/          # Authentication
│   │   └── webhooks/      # Webhook handlers
│   ├── dashboard/         # Dashboard pages
│   │   ├── audit/         # Audit log
│   │   ├── findings/      # Security findings
│   │   └── policies/      # Policy management
│   └── login/             # Login page
├── components/            # React components
│   ├── ui/                # UI components
│   └── dashboard-nav.tsx  # Navigation
└── lib/                   # Utilities and business logic
    ├── armor/             # Security scanning engine
    │   ├── scanner.ts     # Main scanner
    │   └── iq.ts          # Policy engine
    └── prisma.ts          # Prisma client
```

---

## 💡 Tips for First-Time Contributors

1. **Start with small issues** labeled `good first issue` or `help wanted`
2. **Join our community** for real-time help
3. **Read the documentation** thoroughly
4. **Ask questions** if you're unsure
5. **Run the project locally** before making changes
6. **Follow the code style** of existing files
7. **Write meaningful commit messages**
8. **Be patient during review** – we want quality code

---

## ❓ FAQ for Contributors

**How long does the review process take?**  
We aim to review PRs within 2-5 business days. Complex changes may require more time.

**Can I work on multiple issues at once?**  
Yes, but we recommend focusing on one issue at a time to ensure quality and timely delivery.

**Do I need to write tests?**  
Yes! All new features and bug fixes should include appropriate tests. This ensures code quality and prevents regressions.

**How do I get help if I'm stuck?**  
You can:
- Join our community chat
- Comment on the issue/PR
- Send a message to the maintainers
- Check the documentation

---

## 🙏 Thank You

Thank you for taking the time to contribute to SecureFlow! Your efforts make open-source security better for everyone. Every contribution, whether it's fixing a typo or implementing a major feature, is valuable.

**Happy coding! 🚀**

---

<div align="center">

**Made with ❤️ by the SecureFlow Community**

[Report a Bug](https://github.com/GauravKarakoti/SecureFlow/issues) · [Request a Feature](https://github.com/GauravKarakoti/SecureFlow/issues) · [Join Discussion](https://github.com/GauravKarakoti/SecureFlow/discussions)

</div>
