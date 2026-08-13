#!/usr/bin/env node
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LOGGING_SECRET_REGEX = /console\.(log|info|warn|error|debug)\s*\([\s\S]*?(process\.env|password|secret|token|key)[\s\S]*?\)/i;

function getStagedFiles(): string[] {
    try {
        const output = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
        return output.split('\n').filter(Boolean);
    } catch (error) {
        console.error('Failed to get staged files. Are you in a git repository?');
        process.exit(1);
    }
}

function scanFiles() {
    const files = getStagedFiles();
    let hasViolations = false;

    files.forEach(file => {
        const filePath = path.resolve(process.cwd(), file);
        
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);

            lines.forEach((line, index) => {
                const trimmedLine = line.trim();

                // 1. Ignore single-line comments
                if (trimmedLine.startsWith('//')) {
                    return; 
                }

                // 2. Strip string literals ('...', "...", `...`) so we only scan actual code/variables
                const lineWithoutStrings = trimmedLine.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '');

                if (LOGGING_SECRET_REGEX.test(lineWithoutStrings)) {
                    console.error(`🚨 [SecureFlow] Secret logging detected in ${file}:${index + 1}`);
                    console.error(`   -> ${line.trim()}`);
                    hasViolations = true;
                }
            });
        }
    });

    if (hasViolations) {
        console.error('\n❌ SecureFlow blocked this commit. Please remove the exposed secrets/env variables.');
        process.exit(1); 
    } else {
        console.log('✅ SecureFlow scan passed.');
        process.exit(0);
    }
}

scanFiles();