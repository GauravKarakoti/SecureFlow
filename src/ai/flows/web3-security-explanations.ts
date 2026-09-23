/**
 * Web3 & ZK Circuit Security Explanations (#891)
 *
 * Specialized AI flow for smart contract and zero-knowledge circuit findings.
 * Extends the existing security explanation pipeline with domain-specific
 * prompt templates that understand:
 *
 *  - Solidity / EVM: reentrancy, integer overflow, tx.origin auth, delegatecall
 *  - Rust / Soroban / Solana: ownership violations, unsafe arithmetic, CPI risks
 *  - ZK Circuits (Circom, Aleo Leo): under-constrained signals, soundness bugs,
 *    witness-vs-constraint mismatches
 *
 * All prompt-injection pre-filters and output consistency checks from the base
 * flow still run — untrusted contract code is treated identically to untrusted
 * application code.
 */

import {
  AISecurityExplanationInputSchema,
  AISecurityExplanationOutputSchema,
  SYSTEM_PROMPT,
  type AISecurityExplanationInput,
  type AISecurityExplanationOutput,
} from "./security-explanation-schemas";
import { __internal, isRateLimitError, isTimeoutError, withRetry } from "./security-helpers";
import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";

const { contradictsSeverity, detectPromptInjection } = __internal;

// ---------------------------------------------------------------------------
// Web3 ecosystem detection
// ---------------------------------------------------------------------------

export type Web3Ecosystem = "solidity" | "rust-soroban" | "zk-circuit" | "generic-web3";

/**
 * Infer the Web3 ecosystem from the file extension or finding type.
 *
 * Used to select the right prompt template. Falls back to `generic-web3` so
 * the flow always produces a useful explanation even for unknown extensions.
 */
export function detectWeb3Ecosystem(fileLocation: string, findingType: string): Web3Ecosystem {
  const lower = fileLocation.toLowerCase();
  const type = findingType.toLowerCase();

  if (lower.endsWith(".sol") || type.includes("solidity") || type.includes("reentrancy")) {
    return "solidity";
  }
  if (
    lower.endsWith(".rs") ||
    type.includes("soroban") ||
    type.includes("solana") ||
    type.includes("rust")
  ) {
    return "rust-soroban";
  }
  if (
    lower.endsWith(".circom") ||
    lower.endsWith(".leo") ||
    type.includes("circom") ||
    type.includes("aleo") ||
    type.includes("zk") ||
    type.includes("zero-knowledge") ||
    type.includes("circuit")
  ) {
    return "zk-circuit";
  }
  return "generic-web3";
}

// ---------------------------------------------------------------------------
// Ecosystem-specific system prompts
// ---------------------------------------------------------------------------

const SOLIDITY_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  " You are also an expert Solidity and EVM smart contract auditor. " +
  "You understand the Checks-Effects-Interactions pattern, reentrancy guards (ReentrancyGuard), " +
  "integer overflow/underflow (pre-0.8 Solidity), tx.origin authentication bypass, " +
  "delegatecall storage collision, flash loan attack vectors, and access control patterns. " +
  "When analyzing Solidity code, reference the specific EIP or SWC registry entry where applicable.";

const RUST_SOROBAN_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  " You are also an expert Rust smart contract auditor for Soroban (Stellar) and Solana programs. " +
  "You understand Rust ownership and borrow-checker implications for contract safety, " +
  "checked vs unchecked arithmetic (checked_add, saturating_add), " +
  "Cross-Program Invocation (CPI) signer verification, account ownership validation, " +
  "and Anchor framework security constraints. " +
  "Reference the Soroban or Solana security best practices where applicable.";

const ZK_CIRCUIT_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  " You are also an expert zero-knowledge circuit auditor for Circom and Aleo Leo. " +
  "You understand under-constrained signals (signals that are not fully constrained by the circuit), " +
  "soundness bugs (a prover can satisfy the circuit with an invalid witness), " +
  "completeness bugs (a valid witness cannot satisfy the circuit), " +
  "witness-vs-constraint mismatches, missing range checks on field elements, " +
  "and non-deterministic circuit behavior. " +
  "When analyzing Circom, reference the signal/constraint distinction explicitly. " +
  "When analyzing Aleo Leo, reference the Leo type system and constraint generation.";

const GENERIC_WEB3_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  " You are also an expert Web3 security auditor with knowledge of smart contracts, " +
  "decentralized protocols, and cryptographic primitives. " +
  "Apply blockchain-specific threat models including front-running, MEV, oracle manipulation, " +
  "and economic attack vectors in addition to standard vulnerability classes.";

const ECOSYSTEM_SYSTEM_PROMPTS: Record<Web3Ecosystem, string> = {
  solidity: SOLIDITY_SYSTEM_PROMPT,
  "rust-soroban": RUST_SOROBAN_SYSTEM_PROMPT,
  "zk-circuit": ZK_CIRCUIT_SYSTEM_PROMPT,
  "generic-web3": GENERIC_WEB3_SYSTEM_PROMPT,
};

// ---------------------------------------------------------------------------
// Ecosystem-specific prompt builders
// ---------------------------------------------------------------------------

function buildSolidityPrompt(input: AISecurityExplanationInput): string {
  return `Incoming transmission. A smart contract breach has been intercepted.

Threat Class: ${input.findingType}
Threat Level: ${input.severity}
Reconnaissance: ${input.description}
Compromised Contract: ${input.fileLocation}

=== BEGIN UNTRUSTED INTERCEPTED PAYLOAD (Solidity source, fully attacker-controlled) ===
${input.codeSnippet.slice(0, 2000)}
=== END UNTRUSTED INTERCEPTED PAYLOAD ===

Analyze this Solidity code for the reported vulnerability. Consider:
- Reentrancy: Does state change happen AFTER an external call? Is a reentrancy guard present?
- Access control: Is msg.sender checked? Is tx.origin used (bypass risk)?
- Arithmetic: Is this pre-0.8 Solidity without SafeMath, or does it use unchecked blocks?
- Delegatecall: Could storage slots be corrupted by a delegatecall to an untrusted contract?

CRITICAL CONSTRAINTS:
- "explanation": 2 sentences. Name the exact attack vector and the vulnerable line.
- "remediationSuggestions": Provide the corrected Solidity pattern (e.g., Checks-Effects-Interactions, OpenZeppelin ReentrancyGuard import).

Respond ONLY with a valid JSON object with keys "explanation" and "remediationSuggestions".`;
}

function buildRustSorobanPrompt(input: AISecurityExplanationInput): string {
  return `Incoming transmission. A Rust smart contract breach has been intercepted.

Threat Class: ${input.findingType}
Threat Level: ${input.severity}
Reconnaissance: ${input.description}
Compromised Program: ${input.fileLocation}

=== BEGIN UNTRUSTED INTERCEPTED PAYLOAD (Rust source, fully attacker-controlled) ===
${input.codeSnippet.slice(0, 2000)}
=== END UNTRUSTED INTERCEPTED PAYLOAD ===

Analyze this Rust smart contract code for the reported vulnerability. Consider:
- Arithmetic: Is arithmetic unchecked? Should checked_add/saturating_add be used?
- CPI: Are signer seeds verified on Cross-Program Invocations?
- Account validation: Is the account owner checked before deserializing?
- Anchor constraints: Are #[account] constraints sufficient to prevent unauthorized access?

CRITICAL CONSTRAINTS:
- "explanation": 2 sentences. Name the exact Rust/Soroban/Solana vulnerability pattern.
- "remediationSuggestions": Provide the corrected Rust pattern with the specific safe method or Anchor constraint.

Respond ONLY with a valid JSON object with keys "explanation" and "remediationSuggestions".`;
}

function buildZkCircuitPrompt(input: AISecurityExplanationInput): string {
  return `Incoming transmission. A zero-knowledge circuit breach has been intercepted.

Threat Class: ${input.findingType}
Threat Level: ${input.severity}
Reconnaissance: ${input.description}
Compromised Circuit: ${input.fileLocation}

=== BEGIN UNTRUSTED INTERCEPTED PAYLOAD (ZK circuit source, fully attacker-controlled) ===
${input.codeSnippet.slice(0, 2000)}
=== END UNTRUSTED INTERCEPTED PAYLOAD ===

Analyze this ZK circuit for the reported vulnerability. Consider:
- Under-constrained signals: Are all output signals fully determined by the constraints?
- Soundness: Can a malicious prover satisfy the circuit with an invalid witness?
- Range checks: Are field elements constrained to the expected range (e.g., binary signals must be 0 or 1)?
- Completeness: Will a valid witness always satisfy all constraints?

CRITICAL CONSTRAINTS:
- "explanation": 2 sentences. Distinguish between a soundness bug (prover can cheat) and a completeness bug (valid proof rejected).
- "remediationSuggestions": Provide the corrected constraint or the missing range check template.

Respond ONLY with a valid JSON object with keys "explanation" and "remediationSuggestions".`;
}

function buildGenericWeb3Prompt(input: AISecurityExplanationInput): string {
  return `Incoming transmission. A Web3 protocol breach has been intercepted.

Threat Class: ${input.findingType}
Threat Level: ${input.severity}
Reconnaissance: ${input.description}
Compromised Component: ${input.fileLocation}

=== BEGIN UNTRUSTED INTERCEPTED PAYLOAD (Web3 source, fully attacker-controlled) ===
${input.codeSnippet.slice(0, 2000)}
=== END UNTRUSTED INTERCEPTED PAYLOAD ===

Analyze this Web3 code for the reported vulnerability. Apply blockchain-specific threat models
including front-running, oracle manipulation, economic attack vectors, and access control.

CRITICAL CONSTRAINTS:
- "explanation": 2 sentences. Name the exact Web3 attack vector.
- "remediationSuggestions": Provide the corrected pattern with blockchain-specific context.

Respond ONLY with a valid JSON object with keys "explanation" and "remediationSuggestions".`;
}

const ECOSYSTEM_PROMPT_BUILDERS: Record<
  Web3Ecosystem,
  (input: AISecurityExplanationInput) => string
> = {
  solidity: buildSolidityPrompt,
  "rust-soroban": buildRustSorobanPrompt,
  "zk-circuit": buildZkCircuitPrompt,
  "generic-web3": buildGenericWeb3Prompt,
};

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Generate a Web3/ZK-specialized AI security explanation.
 *
 * Selects the appropriate prompt template based on the file extension and
 * finding type, then runs the same injection pre-filter and output consistency
 * checks as the base `developerReceivesAISecurityExplanations` flow.
 *
 * Falls back to the generic Web3 prompt when the ecosystem cannot be inferred.
 */
export async function web3SecurityExplanation(
  input: AISecurityExplanationInput,
): Promise<AISecurityExplanationOutput> {
  const validatedInput = AISecurityExplanationInputSchema.parse(input);

  const injectionFlagged =
    detectPromptInjection(validatedInput.codeSnippet) ||
    detectPromptInjection(validatedInput.description);

  const ecosystem = detectWeb3Ecosystem(validatedInput.fileLocation, validatedInput.findingType);
  const systemPrompt = ECOSYSTEM_SYSTEM_PROMPTS[ecosystem];
  const prompt = ECOSYSTEM_PROMPT_BUILDERS[ecosystem](validatedInput);

  const activeAi = getAiInstance();
  const activeModel = getDefaultModelRef();

  let parsedContent: { explanation?: string; remediationSuggestions?: string } | undefined;

  try {
    const res = await withRetry(
      () =>
        activeAi.generate({
          model: activeModel as any,
          system: systemPrompt,
          prompt,
          config: { maxOutputTokens: 3000, temperature: 0.1 },
        }),
      { initialDelayMs: process.env.NODE_ENV === "test" ? 10 : 100 },
    );

    const responseText = res.text;
    const withoutThoughts = responseText.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
    const jsonMatch = withoutThoughts.match(/[\{\[][^\0]*[\}\]]/);

    if (jsonMatch) {
      try {
        parsedContent = JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to fallback below
      }
    }
  } catch (err) {
    const isRateLimit = isRateLimitError(err);
    const isTimeout = isTimeoutError(err);

    parsedContent = {
      explanation: isRateLimit
        ? "AI provider rate limit reached. Review the static scanner finding directly."
        : isTimeout
          ? "AI provider timed out. Inspect the contract manually."
          : "Signal lost. The Professor is recalculating.",
      remediationSuggestions: isRateLimit
        ? "Wait and retry, or consult the Web3 security checklist manually."
        : "Review the contract against the relevant security checklist for this ecosystem.",
    };
  }

  const explanation = parsedContent?.explanation ?? "No explanation provided.";
  const consistencyFlagged = contradictsSeverity(validatedInput.severity, explanation);

  return AISecurityExplanationOutputSchema.parse({
    explanation,
    remediationSuggestions:
      parsedContent?.remediationSuggestions ?? "No remediation suggestions provided.",
    promptInjectionSuspected: injectionFlagged || consistencyFlagged,
  });
}
