# Require Range Checks on ZK Circuit Field Elements

## Problem

In zero-knowledge circuits, all variables are elements of a Galois field modulo a large prime. If input values representing bounded integers or booleans lack explicit range constraints, a malicious prover can provide numbers greater than the expected bit length that wrap around and bypass logic.

## Example

```circom
// Vulnerable: no range proof verifying that amount <= balance
template Transfer() {
    signal input balance;
    signal input amount;
    signal output remainder;
    remainder <== balance - amount;
}
```

## Fix

Add explicit range-check components (e.g. `Num2Bits` or `LessThan` templates) to constrain the bit width of field elements.

```circom
// Remediated: range constraint enforces amount <= balance
template Transfer(n) {
    signal input balance;
    signal input amount;
    signal output remainder;
    component check = GreaterEqThan(n);
    check.in[0] <== balance;
    check.in[1] <== amount;
    check.out === 1;
    remainder <== balance - amount;
}
```
