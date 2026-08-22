#!/usr/bin/env node

/**
 * Secureflow CLI - Advanced Secret Detection
 * Upgraded version with AI-powered detection capabilities
 * Compatible with husky pre-commit hooks
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// ============ CONFIGURATION ============
const CONFIG = {
  // Advanced regex patterns for secret detection
  patterns: {
    // Generic secrets
    apiKey: /\b(api[_-]?key|apikey|api[-_]?token|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*['"]?([A-Za-z0-9\-_]{16,})['"]?/gi,
    awsKey: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    privateKey: /-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
    jwtToken: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g,
    password: /\b(password|passwd|pwd)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/gi,
    token: /\b(token|bearer|auth|authorization)\s*[:=]\s*['"]?([A-Za-z0-9\-_]{20,})['"]?/gi,
    mongodb: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/g,
    postgresql: /postgresql:\/\/[^:]+:[^@]+@[^\s]+/g,
    redis: /redis:\/\/[^:]+:[^@]+@[^\s]+/g,
    slack: /xox[baprs]-[A-Z0-9]{8,}-[A-Z0-9]{8,}-[A-Z0-9]{8,}-[A-Z0-9]{8,}/g,
    github: /ghp_[A-Za-z0-9]{36}/g,
    gitlab: /glpat-[A-Za-z0-9\-_]{20}/g,
    // Database connection strings
    connectionString: /\b(?:mongodb|mysql|postgresql|redis|elasticsearch):\/\/[^\s]+/gi,
    // Environment variables
    envVar: /\b(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS|AUTH)\w*\s*=\s*['"]?[^'"]+['"]?/gi,
    // Console.log detection with context
    consoleLog: /console\.log\s*\(([^)]*)\)/g,
    // Sensitive data in logs
    sensitiveLog: /console\.(log|info|warn|error|debug)\s*\([^)]*(?:password|secret|token|key|credit|card|ssn|social|security)[^)]*\)/gi,
  },
  
  // AI configuration
  ai: {
    enabled: true,
    confidenceThreshold: 0.7,
    maxFileSize: 1024 * 1024, // 1MB
    maxFilesPerCommit: 50,
  },
  
  // Advanced analysis
  analysis: {
    entropyCheck: true,
    contextAnalysis: true,
    fileTypeDetection: true,
    gitHistoryCheck: true,
  }
};

// ============ UTILITY FUNCTIONS ============
class SecureflowCLI {
  constructor() {
    this.issues = [];
    this.filesProcessed = 0;
    this.entropyCache = new Map();
    this.contextCache = new Map();
  }

  // Calculate entropy of a string (measure of randomness)
  calculateEntropy(str) {
    if (this.entropyCache.has(str)) {
      return this.entropyCache.get(str);
    }
    
    const length = str.length;
    if (length === 0) return 0;
    
    const frequencies = {};
    for (const char of str) {
      frequencies[char] = (frequencies[char] || 0) + 1;
    }
    
    let entropy = 0;
    for (const char in frequencies) {
      const probability = frequencies[char] / length;
      entropy -= probability * Math.log2(probability);
    }
    
    const result = entropy;
    this.entropyCache.set(str, result);
    return result;
  }

  // Check if string has high entropy (likely a secret)
  hasHighEntropy(str, threshold = 4.5) {
    if (str.length < 8) return false;
    const entropy = this.calculateEntropy(str);
    return entropy > threshold;
  }

  // Analyze context around potential secrets
  analyzeContext(content, match, startIndex) {
    const contextWindow = 100;
    const start = Math.max(0, startIndex - contextWindow);
    const end = Math.min(content.length, startIndex + match.length + contextWindow);
    const context = content.substring(start, end);
    
    // Check for common patterns that indicate sensitive data
    const sensitiveContext = [
      'password', 'secret', 'key', 'token', 'auth', 'credential',
      'private', 'confidential', 'restricted', 'internal', 'production'
    ];
    
    const contextLower = context.toLowerCase();
    for (const word of sensitiveContext) {
      if (contextLower.includes(word)) {
        return true;
      }
    }
    
    return false;
  }

  // Detect file type and apply specific rules
  detectFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath).toLowerCase();
    
    const fileTypes = {
      // Configuration files
      config: ['.env', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'],
      // Code files
      code: ['.js', '.ts', '.py', '.java', '.go', '.rb', '.php', '.c', '.cpp', '.cs'],
      // Markup files
      markup: ['.html', '.xml', '.svg', '.md'],
      // Shell scripts
      shell: ['.sh', '.bash', '.zsh', '.fish'],
      // Docker files
      docker: ['dockerfile', 'docker-compose.yml', '.dockerignore'],
    };
    
    for (const [type, extensions] of Object.entries(fileTypes)) {
      if (extensions.includes(ext) || extensions.includes(fileName)) {
        return type;
      }
    }
    
    return 'unknown';
  }

  // Check if file should be excluded
  shouldExcludeFile(filePath) {
    const excludePatterns = [
      'node_modules',
      '.git',
      'dist',
      'build',
      'coverage',
      '.vscode',
      '.idea',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '*.min.js',
      '*.bundle.js',
      '*.test.js',
      '*.spec.js',
    ];
    
    for (const pattern of excludePatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }
    
    return false;
  }

  // Check git history for similar secrets
  checkGitHistory(filePath, match) {
    try {
      const gitLog = execSync(`git log -p -- "${filePath}" | grep -i "${match}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      
      return gitLog.length > 0;
    } catch (error) {
      return false;
    }
  }

  // Advanced regex scanning with context
  advancedScan(content, filePath) {
    const findings = [];
    const fileType = this.detectFileType(filePath);
    
    // Scan each pattern
    for (const [patternName, pattern] of Object.entries(CONFIG.patterns)) {
      let match;
      const regex = new RegExp(pattern);
      
      while ((match = regex.exec(content)) !== null) {
        const matchText = match[0];
        const matchIndex = match.index;
        
        // Skip if it's a false positive
        if (this.isFalsePositive(matchText, filePath, fileType)) {
          continue;
        }
        
        // Check entropy for potential secrets
        let isHighEntropy = false;
        if (CONFIG.analysis.entropyCheck) {
          // Extract potential secret part (usually the second group)
          const secretPart = match[2] || match[1] || matchText;
          isHighEntropy = this.hasHighEntropy(secretPart);
        }
        
        // Analyze context
        let hasSensitiveContext = false;
        if (CONFIG.analysis.contextAnalysis) {
          hasSensitiveContext = this.analyzeContext(content, matchText, matchIndex);
        }
        
        // Check git history (optional)
        let inGitHistory = false;
        if (CONFIG.analysis.gitHistoryCheck) {
          inGitHistory = this.checkGitHistory(filePath, matchText.substring(0, 20));
        }
        
        findings.push({
          pattern: patternName,
          match: matchText,
          line: this.getLineNumber(content, matchIndex),
          column: this.getColumnNumber(content, matchIndex),
          file: filePath,
          fileType: fileType,
          entropy: isHighEntropy,
          sensitiveContext: hasSensitiveContext,
          inGitHistory: inGitHistory,
          severity: this.calculateSeverity(patternName, isHighEntropy, hasSensitiveContext),
        });
      }
    }
    
    return findings;
  }

  // Check for false positives
  isFalsePositive(matchText, filePath, fileType) {
    // Common false positives
    const falsePositives = [
      'example',
      'test',
      'demo',
      'sample',
      'placeholder',
      'xxxx',
      '***',
      'your-',
      'your_',
      'changeme',
      'secret',
      'undefined',
      'null',
      'function',
    ];
    
    const lowerMatch = matchText.toLowerCase();
    for (const fp of falsePositives) {
      if (lowerMatch.includes(fp)) {
        return true;
      }
    }
    
    // Check if it's in test files
    if (filePath.includes('test') || filePath.includes('spec') || filePath.includes('__tests__')) {
      return true;
    }
    
    return false;
  }

  // Get line number from index
  getLineNumber(content, index) {
    return content.substring(0, index).split('\n').length;
  }

  // Get column number from index
  getColumnNumber(content, index) {
    const lines = content.substring(0, index).split('\n');
    return lines[lines.length - 1].length + 1;
  }

  // Calculate severity of finding
  calculateSeverity(pattern, hasHighEntropy, hasSensitiveContext) {
    if (pattern === 'consoleLog' || pattern === 'sensitiveLog') {
      return 'high';
    }
    
    if (hasHighEntropy && hasSensitiveContext) {
      return 'critical';
    } else if (hasHighEntropy || hasSensitiveContext) {
      return 'high';
    } else {
      return 'medium';
    }
  }

  // AI-based detection (simulated with advanced heuristics)
  aiDetection(content, filePath) {
    const aiFindings = [];
    
    // Skip if AI disabled or file too large
    if (!CONFIG.ai.enabled || content.length > CONFIG.ai.maxFileSize) {
      return aiFindings;
    }
    
    // Advanced heuristics
    const lines = content.split('\n');
    let suspectedSecrets = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for patterns that look like secrets but might not match regex
      if (line.length > 20 && line.length < 200) {
        // Check for key-value pairs with long values
        const keyValueMatch = line.match(/([a-zA-Z_\-]+)\s*[:=]\s*['"]?([A-Za-z0-9\-_=+]{20,})['"]?/);
        if (keyValueMatch) {
          const [, key, value] = keyValueMatch;
          const entropy = this.calculateEntropy(value);
          
          if (entropy > 4.5) {
            suspectedSecrets.push({
              line: i + 1,
              key: key,
              value: value.substring(0, 20) + '...',
              confidence: Math.min(entropy / 8, 1),
              reasoning: `High entropy (${entropy.toFixed(2)}) in value for key "${key}"`
            });
          }
        }
        
        // Check for encoded data (base64, hex, etc.)
        const base64Match = line.match(/[A-Za-z0-9+\/]{20,}={0,2}/);
        if (base64Match && this.hasHighEntropy(base64Match[0])) {
          suspectedSecrets.push({
            line: i + 1,
            value: base64Match[0].substring(0, 20) + '...',
            confidence: 0.8,
            reasoning: 'Base64 encoded data with high entropy detected'
          });
        }
      }
    }
    
    // Filter by confidence threshold
    return suspectedSecrets
      .filter(s => s.confidence >= CONFIG.ai.confidenceThreshold)
      .map(s => ({
        ...s,
        type: 'ai_detected_secret',
        severity: 'high',
      }));
  }

  // Main scanning function
  scanFile(filePath) {
    try {
      // Skip excluded files
      if (this.shouldExcludeFile(filePath)) {
        return [];
      }
      
      // Read file content
      const content = fs.readFileSync(filePath, 'utf8');
      this.filesProcessed++;
      
      // Run regex-based scanning
      const findings = this.advancedScan(content, filePath);
      
      // Run AI-based detection (if enabled)
      if (CONFIG.ai.enabled) {
        const aiFindings = this.aiDetection(content, filePath);
        findings.push(...aiFindings);
      }
      
      return findings;
    } catch (error) {
      console.error(`Error scanning ${filePath}:`, error.message);
      return [];
    }
  }

  // Get staged files from git
  getStagedFiles() {
    try {
      const output = execSync('git diff --staged --name-only --diff-filter=ACM', {
        encoding: 'utf8'
      });
      return output.split('\n').filter(Boolean);
    } catch (error) {
      console.error('Error getting staged files:', error.message);
      return [];
    }
  }

  // Generate report
  generateReport(findings) {
    if (findings.length === 0) {
      console.log('✅ No sensitive information detected!');
      return;
    }
    
    console.log('========================================');
    console.log('🔍 SECUREFLOW SECURITY SCAN REPORT');
    console.log('========================================');
    console.log(`📁 Files scanned: ${this.filesProcessed}`);
    console.log(`🚨 Issues found: ${findings.length}`);
    console.log('----------------------------------------');
    
    // Group findings by severity
    const groupedFindings = {
      critical: findings.filter(f => f.severity === 'critical'),
      high: findings.filter(f => f.severity === 'high'),
      medium: findings.filter(f => f.severity === 'medium'),
      low: findings.filter(f => f.severity === 'low'),
    };
    
    // Print findings
    for (const [severity, items] of Object.entries(groupedFindings)) {
      if (items.length === 0) continue;
      
      const emoji = {
        critical: '🔴',
        high: '🟠',
        medium: '🟡',
        low: '🔵'
      };
      
      console.log(`\n${emoji[severity]} ${severity.toUpperCase()} SEVERITY (${items.length}):`);
      console.log('----------------------------------------');
      
      items.forEach((item, index) => {
        console.log(`${index + 1}. 📄 ${item.file}:${item.line}`);
        console.log(`   ⚠️  Pattern: ${item.pattern}`);
        console.log(`   🔑  Match: ${item.match.substring(0, 80)}${item.match.length > 80 ? '...' : ''}`);
        
        if (item.entropy) {
          console.log(`   📊  High entropy detected`);
        }
        if (item.sensitiveContext) {
          console.log(`   📝  Sensitive context detected`);
        }
        if (item.inGitHistory) {
          console.log(`   📜  Found in git history`);
        }
        if (item.type === 'ai_detected_secret') {
          console.log(`   🤖  AI Detection: ${item.reasoning}`);
          console.log(`   📊  Confidence: ${(item.confidence * 100).toFixed(0)}%`);
        }
        console.log('');
      });
    }
    
    console.log('========================================');
    console.log('💡 RECOMMENDATIONS:');
    console.log('----------------------------------------');
    console.log('• Use environment variables for sensitive data');
    console.log('• Never log passwords, tokens, or credentials');
    console.log('• Consider using secret management tools (e.g., HashiCorp Vault)');
    console.log('• Review and remove any hardcoded secrets');
    console.log('========================================\n');
    
    // Exit with error if critical/high issues found
    const criticalAndHigh = findings.filter(f => 
      f.severity === 'critical' || f.severity === 'high'
    );
    
    if (criticalAndHigh.length > 0) {
      console.error(`❌ ${criticalAndHigh.length} critical/high severity issues found!`);
      console.error('🚫 Commit blocked! Please fix these issues before committing.');
      process.exit(1);
    }
  }

  // Main execution
  run() {
    const files = this.getStagedFiles();
    
    if (files.length === 0) {
      console.log('📝 No staged files to scan.');
      return;
    }
    
    console.log(`🔍 Scanning ${files.length} staged files...`);
    
    let allFindings = [];
    for (const file of files) {
      const findings = this.scanFile(file);
      allFindings = allFindings.concat(findings);
    }
    
    this.generateReport(allFindings);
  }
}

// ============ MAIN EXECUTION ============
if (require.main === module) {
  const cli = new SecureflowCLI();
  cli.run();
}

module.exports = SecureflowCLI;
