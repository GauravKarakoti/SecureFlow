# Block tx.origin Authentication in Solidity

## Problem

Using `tx.origin` for authorization checks the original account that signed and submitted the transaction across the entire call stack rather than the immediate caller (`msg.sender`). Attackers can construct phishing contracts that trick victim owners into sending a transaction that invokes the vulnerable contract on their behalf (SWC-115).

## Example

```solidity
// Vulnerable: tx.origin can be spoofed via phishing proxy contracts
function transferOwnership(address newOwner) public {
    require(tx.origin == owner, "Only owner can transfer ownership");
    owner = newOwner;
}
```

## Fix

Always authenticate callers using `msg.sender` to guarantee that only the direct caller is verified.

```solidity
// Remediated: msg.sender authenticates direct caller
function transferOwnership(address newOwner) public {
    require(msg.sender == owner, "Only owner can transfer ownership");
    owner = newOwner;
}
```
