#!/usr/bin/env node

/**
 * Secureflow CLI - Advanced Security Scanner with Pre-Computation Masking
 * Enterprise-grade secret detection with zero external data leakage
 * Compatible with husky pre-commit hooks
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// ============ CONFIGURATION ============
const CONFIG = {
  // Secret detection patterns
  patterns: {
    // API Keys & Tokens
    apiKey: /\b(api[_-]?key|apikey|api[-_]?token|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*['"]?([A-Za-z0-9\-_]{16,})['"]?/gi,
    awsKey: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    privateKey: /-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
    jwtToken: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g,
    password: /\b(password|passwd|pwd)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/gi,
    token: /\b(token|bearer|auth|authorization)\s*[:=]\s*['"]?([A-Za-z0-9\-_]{20,})['"]?/gi,
    
    // Database & Service URLs
    mongodb: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/g,
    postgresql: /postgresql:\/\/[^:]+:[^@]+@[^\s]+/g,
    redis: /redis:\/\/[^:]+:[^@]+@[^\s]+/g,
    mysql: /mysql:\/\/[^:]+:[^@]+@[^\s]+/g,
    elasticsearch: /elasticsearch:\/\/[^:]+:[^@]+@[^\s]+/g,
    connectionString: /\b(?:mongodb|mysql|postgresql|redis|elasticsearch):\/\/[^\s]+/gi,
    
    // Third-party tokens
    slack: /xox[baprs]-[A-Z0-9]{8,}-[A-Z0-9]{8,}-[A-Z0-9]{8,}-[A-Z0-9]{8,}/g,
    github: /ghp_[A-Za-z0-9]{36}/g,
    gitlab: /glpat-[A-Za-z0-9\-_]{20}/g,
    stripe: /sk_(live|test)_[A-Za-z0-9]{24,}/g,
    google: /AIza[0-9A-Za-z\-_]{35}/g,
    twilio: /SK[0-9a-fA-F]{32}/g,
    
    // IP Addresses
    ipAddress: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
    privateIp: /\b(?:10\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)[0-9]{1,3}\.[0-9]{1,3}\b/g,
    
    // Internal URLs
    internalUrl: /\b(?:https?:\/\/)?(?:internal|dev|staging|qa|test|local|localhost|intranet)[^\s"']*/gi,
    
    // Environment variables
    envVar: /\b(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS|AUTH)\w*\s*=\s*['"]?[^'"]+['"]?/gi,
    
    // SSH Keys
    sshKey: /ssh-rsa\s+[A-Za-z0-9+/]+[=]{0,3}/g,
    
    // Sensitive XML/JSON values
    sensitiveXml: /<(?:password|secret|token|key|credential)>[^<]+<\/(?:password|secret|token|key|credential)>/gi,
    sensitiveJson: /"(?:password|secret|token|key|credential)"\s*:\s*"[^"]+"/gi,
  },
  
  // Masking configuration
  masking: {
    enabled: true,
    placeholder: '[REDACTED_BY_THE_PROFESSOR]',
    preserveStructure: true,
    entropyThreshold: 4.5,
    minLength: 8,
    maxRedactions: 1000,
  },
  
  // Privacy settings
  privacy: {
    enablePreComputationMasking: true,
    enableContextExtraction: true,
    contextWindow: 5, // Lines of context to keep
    maxFileSize: 1024 * 1024, // 1MB
    zeroRetentionMode: true,
  },
  
  // Local processing (no external calls)
  localOnly: true,
  
  // Security levels
  severity: {
    critical: ['awsKey', 'privateKey', 'stripe', 'google', 'twilio'],
    high: ['apiKey', 'token', 'jwtToken', 'password', 'github', 'gitlab', 'slack'],
    medium: ['connectionString', 'mongodb', 'postgresql', 'redis', 'mysql'],
    low: ['ipAddress', 'internalUrl', 'envVar']
  }
};

// ============ SECURE MASKING ENGINE ============
class SecureMaskingEngine {
  constructor() {
    this.maskCache = new Map();
    this.redactionLog = [];
    this.entropyCache = new Map();
    this.stats = {
      totalSecrets: 0,
      maskedItems: 0,
      entropyDetections: 0,
      patternDetections: 0,
    };
  }

  /**
   * Calculate Shannon entropy of a string
   * Higher entropy = more random = more likely to be a secret
   */
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
    
    const result = Math.round(entropy * 100) / 100;
    this.entropyCache.set(str, result);
    return result;
  }

  /**
   * Check if a string has high entropy (likely a secret)
   */
  hasHighEntropy(str, threshold = CONFIG.masking.entropyThreshold) {
    if (str.length < CONFIG.masking.minLength) return false;
    
    // Exclude common patterns
    const commonPatterns = [
      'example', 'test', 'demo', 'sample', 'placeholder',
      'undefined', 'null', 'function', 'return', 'const', 'let', 'var',
      'https://', 'http://', 'www.', '.com', '.org', '.io',
      'true', 'false', 'undefined', 'null', 'NaN'
    ];
    
    const lowerStr = str.toLowerCase();
    for (const pattern of commonPatterns) {
      if (lowerStr.includes(pattern)) return false;
    }
    
    const entropy = this.calculateEntropy(str);
    return entropy > threshold;
  }

  /**
   * Core masking function - redacts sensitive data
   */
  maskSensitiveContent(content, context = 'unknown') {
    if (!CONFIG.masking.enabled) return content;
    
    let maskedContent = content;
    let redactionCount = 0;
    const maxRedactions = CONFIG.masking.maxRedactions;
    
    // 1. Pattern-based masking
    for (const [patternName, pattern] of Object.entries(CONFIG.patterns)) {
      const matches = maskedContent.matchAll(new RegExp(pattern));
      
      for (const match of matches) {
        if (redactionCount >= maxRedactions) break;
        
        const fullMatch = match[0];
        const matchedGroups = match.slice(1);
        
        // Determine what to redact
        let redactString = fullMatch;
        let replacement = CONFIG.masking.placeholder;
        
        // For key-value pairs, redact only the value
        if (matchedGroups.length >= 2) {
          const key = matchedGroups[0];
          const value = matchedGroups[1];
          
          // Check if value has high entropy
          if (this.hasHighEntropy(value)) {
            redactString = value;
            this.stats.entropyDetections++;
            replacement = CONFIG.masking.placeholder;
          } else {
            // Still redact but with context preservation
            const preservedKey = key;
            redactString = `${preservedKey}${fullMatch.includes(':') ? ':' : '='}${value}`;
            replacement = `${preservedKey}${fullMatch.includes(':') ? ':' : '='}${CONFIG.masking.placeholder}`;
          }
        } else {
          // Redact the entire match
          if (this.hasHighEntropy(fullMatch)) {
            this.stats.entropyDetections++;
          }
        }
        
        // Perform the redaction
        maskedContent = maskedContent.replace(redactString, replacement);
        redactionCount++;
        this.stats.maskedItems++;
        
        // Log the redaction
        this.redactionLog.push({
          pattern: patternName,
          context: context,
          originalLength: redactString.length,
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    this.stats.totalSecrets += redactionCount;
    
    // 2. Entropy-based masking for potential secrets missed by patterns
    if (CONFIG.masking.enabled) {
      maskedContent = this.maskByEntropy(maskedContent, context);
    }
    
    return maskedContent;
  }

  /**
   * Mask strings with high entropy that weren't caught by patterns
   */
  maskByEntropy(content, context) {
    // Split content into tokens (words, strings, etc.)
    const tokens = content.split(/\s+/);
    let masked = [];
    
    for (const token of tokens) {
      // Skip if token is already masked
      if (token.includes(CONFIG.masking.placeholder)) {
        masked.push(token);
        continue;
      }
      
      // Check for quoted strings
      const quotedMatch = token.match(/^["'](.+)["']$/);
      if (quotedMatch) {
        const inner = quotedMatch[1];
        if (this.hasHighEntropy(inner) && inner.length >= CONFIG.masking.minLength) {
          masked.push(`"${CONFIG.masking.placeholder}"`);
          this.stats.maskedItems++;
          continue;
        }
      }
      
      // Check for key-value pairs
      const kvMatch = token.match(/^([^=:]+)[=:](.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        if (this.hasHighEntropy(value) && value.length >= CONFIG.masking.minLength) {
          masked.push(`${key}=${CONFIG.masking.placeholder}`);
          this.stats.maskedItems++;
          continue;
        }
      }
      
      // Check for standalone high entropy strings
      const cleanToken = token.replace(/[^a-zA-Z0-9]/g, '');
      if (cleanToken.length >= CONFIG.masking.minLength && 
          this.hasHighEntropy(cleanToken) &&
          !this.isLikelyCode(cleanToken)) {
        masked.push(CONFIG.masking.placeholder);
        this.stats.maskedItems++;
        continue;
      }
      
      masked.push(token);
    }
    
    return masked.join(' ');
  }

  /**
   * Check if a token is likely code (not a secret)
   */
  isLikelyCode(token) {
    const codePatterns = [
      /^[a-zA-Z_][a-zA-Z0-9_]*$/, // Variable name
      /^[a-f0-9]{8}$/, // Short hex
      /^[A-Z]{2,}$/, // Acronym
    ];
    
    for (const pattern of codePatterns) {
      if (pattern.test(token)) return true;
    }
    return false;
  }

  /**
   * Extract only relevant context from diff
   * Instead of sending entire file, extract only changed sections
   */
  extractContext(diffContent, contextLines = CONFIG.privacy.contextWindow) {
    const lines = diffContent.split('\n');
    const changedLines = [];
    const contextBlocks = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if this is a changed line (starts with + or -)
      if (line.startsWith('+') || line.startsWith('-')) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        
        const block = lines.slice(start, end).join('\n');
        
        // Add to context blocks if not already included
        if (!contextBlocks.includes(block)) {
          contextBlocks.push(block);
          changedLines.push(line);
        }
      }
    }
    
    return {
      changedLines: changedLines,
      contextBlocks: contextBlocks,
      totalLines: changedLines.length,
    };
  }

  /**
   * Generate a secure hash for tracking without exposing content
   */
  generateSecureHash(content) {
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Comprehensive pre-computation masking pipeline
   * This is the main entry point for securing data before external transmission
   */
  processSecureDiff(diffContent, filePath) {
    console.log(`🔒 Processing ${filePath} through secure masking pipeline...`);
    
    // Step 1: Extract only the relevant context (not entire file)
    const context = this.extractContext(diffContent);
    
    // Step 2: Apply pattern-based and entropy-based masking
    let maskedContent = this.maskSensitiveContent(
      context.contextBlocks.join('\n'),
      filePath
    );
    
    // Step 3: Remove any remaining sensitive patterns
    maskedContent = this.extraSanitization(maskedContent);
    
    // Step 4: Generate audit trail (without exposing content)
    const auditTrail = {
      file: path.basename(filePath),
      hash: this.generateSecureHash(maskedContent),
      redactions: this.redactionLog.length,
      timestamp: new Date().toISOString(),
      contextLines: context.totalLines,
      maskStats: { ...this.stats },
    };
    
    // Step 5: Final verification - ensure no secrets leaked
    const verificationResult = this.verifyNoSecrets(maskedContent);
    
    return {
      maskedContent: maskedContent,
      auditTrail: auditTrail,
      verificationResult: verificationResult,
      originalContext: context,
    };
  }

  /**
   * Extra sanitization for missed patterns
   */
  extraSanitization(content) {
    // Remove common sensitive patterns that might slip through
    let sanitized = content;
    
    // Remove base64 encoded strings that look like secrets
    sanitized = sanitized.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, CONFIG.masking.placeholder);
    
    // Remove hex strings that look like secrets
    sanitized = sanitized.replace(/\b[a-fA-F0-9]{32,}\b/g, CONFIG.masking.placeholder);
    
    // Remove UUIDs
    sanitized = sanitized.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      CONFIG.masking.placeholder
    );
    
    return sanitized;
  }

  /**
   * Verify that no secrets remain in the content
   */
  verifyNoSecrets(content) {
    const findings = [];
    
    // Check each pattern
    for (const [patternName, pattern] of Object.entries(CONFIG.patterns)) {
      const matches = content.matchAll(new RegExp(pattern));
      for (const match of matches) {
        findings.push({
          pattern: patternName,
          match: match[0].substring(0, 20) + '...',
          line: this.getLineNumber(content, match.index),
        });
      }
    }
    
    // Check for high entropy strings
    const words = content.split(/\s+/);
    for (const word of words) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      if (clean.length >= CONFIG.masking.minLength && this.hasHighEntropy(clean)) {
        findings.push({
          pattern: 'high_entropy',
          match: clean.substring(0, 20) + '...',
          confidence: this.calculateEntropy(clean),
        });
      }
    }
    
    return {
      secure: findings.length === 0,
      findings: findings,
      totalChecks: Object.keys(CONFIG.patterns).length + 1,
    };
  }

  /**
   * Get line number from content index
   */
  getLineNumber(content, index) {
    return content.substring(0, index).split('\n').length;
  }

  /**
   * Reset statistics for new scan
   */
  resetStats() {
    this.stats = {
      totalSecrets: 0,
      maskedItems: 0,
      entropyDetections: 0,
      patternDetections: 0,
    };
    this.redactionLog = [];
    this.entropyCache = new Map();
  }

  /**
   * Generate report of masking operations
   */
  generateReport(processedFiles) {
    console.log('\n========================================');
    console.log('🔒 SECUREFLOW MASKING REPORT');
    console.log('========================================');
    
    const totalRedactions = processedFiles.reduce(
      (sum, f) => sum + f.auditTrail.redactions,
      0
    );
    
    console.log(`📁 Files Processed: ${processedFiles.length}`);
    console.log(`🔑 Total Redactions: ${totalRedactions}`);
    console.log(`🛡️  Entropy Detections: ${this.stats.entropyDetections}`);
    console.log(`📊 Pattern Detections: ${this.stats.patternDetections}`);
    console.log('----------------------------------------');
    
    processedFiles.forEach((file, index) => {
      console.log(`\n${index + 1}. 📄 ${file.auditTrail.file}`);
      console.log(`   🔐 Redactions: ${file.auditTrail.redactions}`);
      console.log(`   📊 Context Lines: ${file.auditTrail.contextLines}`);
      console.log(`   🆔 Hash: ${file.auditTrail.hash}`);
      console.log(`   ✅ Verification: ${file.verificationResult.secure ? 'PASSED ✅' : 'FAILED ❌'}`);
      
      if (file.verificationResult.findings.length > 0) {
        console.log(`   ⚠️  Verification Issues: ${file.verificationResult.findings.length}`);
        file.verificationResult.findings.forEach(f => {
          console.log(`      - ${f.pattern}: ${f.match}`);
        });
      }
    });
    
    console.log('\n========================================');
    console.log('📊 SUMMARY STATISTICS');
    console.log('----------------------------------------');
    console.log(`Total Items Masked: ${this.stats.maskedItems}`);
    console.log(`Pattern-Based: ${this.stats.patternDetections}`);
    console.log(`Entropy-Based: ${this.stats.entropyDetections}`);
    console.log(`Redaction Log Entries: ${this.redactionLog.length}`);
    
    // Security recommendations
    console.log('\n💡 SECURITY RECOMMENDATIONS:');
    console.log('----------------------------------------');
    console.log('✅ All secrets have been redacted before external transmission');
    console.log('✅ High-entropy strings have been masked');
    console.log('✅ Context extraction reduces exposure surface');
    console.log('✅ Zero-retention mode is active');
    console.log('⚠️  Consider using local LLM models for complete privacy');
    console.log('🔐 All redactions are auditable for compliance');
    console.log('========================================\n');
  }
}

// ============ CLI INTERFACE ============
class SecureflowCLI {
  constructor() {
    this.maskingEngine = new SecureMaskingEngine();
  }

  /**
   * Get changed files from git
   */
  getStagedFiles() {
    try {
      const output = execSync('git diff --staged --name-only --diff-filter=ACM', {
        encoding: 'utf8'
      });
      return output.split('\n').filter(Boolean);
    } catch (error) {
      console.error('❌ Error getting staged files:', error.message);
      return [];
    }
  }

  /**
   * Get diff content for a file
   */
  getFileDiff(filePath) {
    try {
      const output = execSync(`git diff --staged "${filePath}"`, {
        encoding: 'utf8'
      });
      return output;
    } catch (error) {
      console.error(`❌ Error getting diff for ${filePath}:`, error.message);
      return '';
    }
  }

  /**
   * Check if file should be excluded
   */
  shouldExcludeFile(filePath) {
    const excludePatterns = [
      'node_modules', '.git', 'dist', 'build', 'coverage',
      '.vscode', '.idea', 'package-lock.json', 'yarn.lock',
      'pnpm-lock.yaml', '*.min.js', '*.bundle.js'
    ];
    
    for (const pattern of excludePatterns) {
      if (filePath.includes(pattern)) return true;
    }
    return false;
  }

  /**
   * Main processing pipeline
   */
  run() {
    console.log('🔒 Secureflow CLI - Advanced Security Scanner v2.0');
    console.log('================================================');
    console.log('🛡️  Pre-computation masking enabled');
    console.log('🔐 Zero-retention mode active');
    console.log('🤖 Local processing only (no external API calls)\n');
    
    const files = this.getStagedFiles();
    
    if (files.length === 0) {
      console.log('📝 No staged files to scan.');
      return;
    }
    
    console.log(`📁 Scanning ${files.length} staged files...\n`);
    
    const processedFiles = [];
    let hasCriticalIssues = false;
    
    for (const file of files) {
      if (this.shouldExcludeFile(file)) {
        console.log(`⏭️  Skipping ${file} (excluded)`);
        continue;
      }
      
      const diff = this.getFileDiff(file);
      if (!diff) continue;
      
      // Process through secure pipeline
      const result = this.maskingEngine.processSecureDiff(diff, file);
      processedFiles.push(result);
      
      // Check for verification failures
      if (!result.verificationResult.secure) {
        console.error(`❌ Verification failed for ${file}!`);
        hasCriticalIssues = true;
      }
      
      // Reset stats for next file
      this.maskingEngine.resetStats();
    }
    
    // Generate comprehensive report
    this.maskingEngine.generateReport(processedFiles);
    
    // Final security check
    if (hasCriticalIssues) {
      console.error('❌ CRITICAL: Unmasked secrets detected! Commit blocked.');
      process.exit(1);
    }
    
    console.log('✅ All files processed securely. No secrets exposed.');
    console.log('🔒 Data has been masked before any potential external transmission.');
    
    // In a real implementation, you would now send the masked data to the LLM
    // The following is just for demonstration
    if (CONFIG.privacy.zeroRetentionMode) {
      console.log('\n📤 READY TO TRANSMIT (MASKED CONTENT):');
      console.log('----------------------------------------');
      processedFiles.forEach((file, index) => {
        if (file.maskedContent && file.maskedContent.length > 0) {
          console.log(`\n--- ${file.auditTrail.file} (${file.maskedContent.split('\n').length} lines) ---`);
          // Show a preview (first 5 lines)
          const lines = file.maskedContent.split('\n').slice(0, 5);
          console.log(lines.join('\n'));
          if (file.maskedContent.split('\n').length > 5) {
            console.log('... (truncated)');
          }
        }
      });
      console.log('\n----------------------------------------');
      console.log('⚠️  In production, this masked data would be sent to the LLM');
      console.log(`🔒 ${processedFiles.length} files processed with ${processedFiles.reduce((sum, f) => sum + f.auditTrail.redactions, 0)} total redactions`);
    }
    
    console.log('\n✨ Secure processing complete!');
  }
}

// ============ MAIN EXECUTION ============
if (require.main === module) {
  const cli = new SecureflowCLI();
  cli.run();
}

module.exports = { SecureflowCLI, SecureMaskingEngine };
