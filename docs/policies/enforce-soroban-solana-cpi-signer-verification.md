# Enforce Soroban/Solana CPI Signer Verification

## Problem

In Solana and Soroban smart contracts, performing Cross-Program Invocations (CPI) without verifying program IDs, account ownership, or signer seeds allows malicious callers to pass counterfeit program accounts or execute instructions on behalf of unintended accounts.

## Example

```rust
// Vulnerable: invoking instruction without verifying program ID or signer status
invoke(&instruction, &[account_a.clone(), account_b.clone()])?;
```

## Fix

Validate program IDs and signer permissions, and execute CPIs using signed PDA seeds with `invoke_signed`.

```rust
// Remediated: verify program ID, signer requirements, and invoke with seeds
require_keys_eq!(account_b.key(), expected_program::ID, ProgramError::IncorrectProgramId);
require!(account_a.is_signer, ProgramError::MissingRequiredSignature);
invoke_signed(&instruction, &[account_a, account_b], signer_seeds)?;
```
