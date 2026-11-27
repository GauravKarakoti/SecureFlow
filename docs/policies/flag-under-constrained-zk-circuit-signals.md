# Flag Under-Constrained ZK Circuit Signals

## Problem

In zero-knowledge domain-specific languages like Circom and Aleo Leo, using intermediate signal assignments (`<--` or `=`) without quadratic polynomial equality constraints (`===` or `<==`) produces under-constrained circuits. A malicious prover can forge proofs for invalid witness inputs without satisfying application soundness.

## Example

```circom
// Vulnerable: assignment without polynomial constraint
template Multiply() {
    signal input a;
    signal input b;
    signal output c;
    c <-- a * b;
}
```

## Fix

Use constrained assignments (`<==`) or explicitly add quadratic constraints (`===`) to ensure output signals are mathematically bound to inputs.

```circom
// Remediated: constrained signal assignment
template Multiply() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}
```
