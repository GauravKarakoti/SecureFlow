# Flag Unchecked Arithmetic in Smart Contracts

## Problem
Bypassing compiler arithmetic checks in Solidity via `unchecked {}` blocks or using unchecked integer arithmetic in Rust programs can allow values to overflow or underflow silently, corrupting balances or token supplies.

## Example
```solidity
// Vulnerable: unchecked block allows underflow if amount > balance
function debit(address account, uint256 amount) public {
    unchecked {
        balances[account] -= amount;
    }
}
```

## Fix
Rely on Solidity 0.8+ default checked arithmetic or explicitly validate preconditions before entering `unchecked {}` blocks.

```solidity
// Remediated: explicit bounds verification
function debit(address account, uint256 amount) public {
    require(balances[account] >= amount, "Insufficient account balance");
    unchecked {
        balances[account] -= amount;
    }
}
```
